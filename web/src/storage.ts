// Uploaded kits, kept in this browser's IndexedDB (idb-keyval) so they survive a reload, with their layout.
// At most MAX_UPLOADS are kept; saving one more drops the least recently used. Entries from an older schema
// are migrated on load (migrate); entries that can't be are dropped one by one.
import { createStore, del, entries, get, set, type UseStore } from 'idb-keyval';
import type { Layout, Part } from './kit';
import { centroid } from './vision/symmetry';
import type { UploadResult } from './worker/protocol';

/** Bump when the stored shape changes, and teach migrate() the old one. */
export const SCHEMA = 2;
export const MAX_UPLOADS = 20;

export interface StoredUpload extends UploadResult {
  schema: typeof SCHEMA;
  /** When it was uploaded and last selected (ms since the epoch). */
  created: number;
  used: number;
  /** How the kit was last laid out; without it the kit's initial layout. */
  layout?: Layout;
}

let db: UseStore | null = null;
const store = () => (db ??= createStore('gridfinity-tool-studio', 'uploads'));

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object';
const isRing = (v: unknown) => Array.isArray(v) && v.length >= 3 && v.every((q) => Array.isArray(q) && q.length === 2);
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isAffine = (v: unknown) => Array.isArray(v) && v.length === 2
  && v.every((r) => Array.isArray(r) && r.length === 3 && r.every(isNum));
const isPart = (v: unknown): v is Part => isObj(v) && typeof v.id === 'string' && isRing(v.outline)
  && Array.isArray(v.crop) && isAffine(v.up2sheet) && isObj(v.symmetry) && isRing(v.symmetry.outline)
  && Array.isArray(v.symmetry.centre);
const isLayout = (v: unknown): v is Layout => isObj(v) && Array.isArray(v.placements) && v.placements.every(isObj);

/** The fields every schema shares, or null when they are missing. */
function common(v: Obj): Omit<StoredUpload, 'schema' | 'parts' | 'layout'> | null {
  if (typeof v.id !== 'string' || typeof v.label !== 'string' || !(v.sheetViewJpeg instanceof Blob)
    || !Array.isArray(v.sheetBox) || v.sheetBox.length !== 4) return null;
  const now = Date.now();
  return {
    id: v.id, label: v.label, sym: v.sym === true, sheetViewJpeg: v.sheetViewJpeg, sheetBox: v.sheetBox as StoredUpload['sheetBox'],
    created: isNum(v.created) ? (v.created as number) : now, used: isNum(v.used) ? (v.used as number) : now,
  };
}

/** A stored record in the current schema: as is, or migrated from schema 1 (one tool) to a one-part kit.
 * Null when it is neither. */
export function migrate(v: unknown): StoredUpload | null {
  if (!isObj(v)) return null;
  const base = common(v);
  if (!base) return null;
  if (v.schema === SCHEMA) {
    if (!Array.isArray(v.parts) || !v.parts.length || !v.parts.every(isPart)) return null;
    return { ...base, schema: SCHEMA, parts: v.parts, ...(isLayout(v.layout) ? { layout: v.layout } : {}) };
  }
  if (v.schema !== 1 || !isRing(v.outline) || !Array.isArray(v.crop) || !isAffine(v.up2sheet) || !isObj(v.symmetry)
    || !isRing(v.symmetry.outline)) return null;
  const s = v.symmetry;
  const outline = v.outline as Part['outline'];
  const part: Part = {
    id: 'p1',
    outline,
    crop: v.crop as Part['crop'],
    up2sheet: v.up2sheet as Part['up2sheet'],
    symmetry: {
      outline: s.outline as Part['outline'],
      score: isNum(s.score) ? (s.score as number) : 0,
      axisDeg: isNum(s.axisDeg) ? (s.axisDeg as number) : 0,
      offset: isNum(s.offset) ? (s.offset as number) : 0,
      centre: centroid(outline),
    },
  };
  return { ...base, schema: SCHEMA, parts: [part] };
}

/** Writes to one upload, run one after another so a read-modify-write never loses another's update. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(id) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(id, tail);
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return run;
}

/** All stored uploads, oldest first. Older entries are migrated and written back; ones that can't be are
 * deleted. Each entry is handled on its own, so one bad entry costs only itself. */
export async function loadUploads(): Promise<StoredUpload[]> {
  const all = await entries<string, unknown>(store());
  const out: StoredUpload[] = [];
  for (const [key, v] of all) {
    try {
      const u = migrate(v);
      if (!u || u.id !== key) await del(key, store());
      else {
        if ((v as Obj).schema !== SCHEMA) await serial(key, () => set(key, u, store()));
        out.push(u);
      }
    } catch {
      // a record that can't be read or written is skipped, not fatal
    }
  }
  return out.sort((a, b) => a.created - b.created);
}

/** Ids of the least recently used uploads beyond the first `max`. */
export function overflow(uploads: Pick<StoredUpload, 'id' | 'used'>[], max = MAX_UPLOADS): string[] {
  return [...uploads].sort((a, b) => a.used - b.used).slice(0, Math.max(0, uploads.length - max)).map((x) => x.id);
}

/** Store a new upload. Returns the ids of the uploads dropped to stay within MAX_UPLOADS. */
export async function saveUpload(u: UploadResult, now = Date.now()): Promise<string[]> {
  await serial(u.id, () => set(u.id, { ...u, schema: SCHEMA, created: now, used: now } satisfies StoredUpload, store()));
  const evict = overflow(await loadUploads());
  for (const id of evict) await serial(id, () => del(id, store()));
  return evict;
}

/** Change a stored upload in place (nothing when it is gone). */
function update(id: string, change: (u: StoredUpload) => StoredUpload): Promise<void> {
  return serial(id, async () => {
    const u = migrate(await get<unknown>(id, store()));
    if (u) await set(id, change(u), store());
  });
}

/** Mark an upload as just used, so it is the last to be dropped. */
export function touchUpload(id: string, now = Date.now()): Promise<void> {
  return update(id, (u) => ({ ...u, used: now }));
}

/** Remember how an upload's kit is laid out. */
export function saveLayout(id: string, layout: Layout): Promise<void> {
  return update(id, (u) => ({ ...u, layout }));
}

export async function removeUpload(id: string): Promise<void> {
  await serial(id, () => del(id, store()));
}
