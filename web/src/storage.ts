// Uploaded tools, kept in this browser's IndexedDB (idb-keyval) so they survive a reload. At most MAX_UPLOADS
// are kept; saving one more drops the least recently used. Entries from another schema version are dropped.
import { createStore, del, entries, get, set, type UseStore } from 'idb-keyval';
import type { UploadResult } from './worker/protocol';

/** Bump when the stored shape changes; older entries are then deleted on load. */
export const SCHEMA = 1;
export const MAX_UPLOADS = 20;

export interface StoredUpload extends UploadResult {
  schema: typeof SCHEMA;
  /** When it was uploaded and last selected (ms since the epoch). */
  created: number;
  used: number;
}

let db: UseStore | null = null;
const store = () => (db ??= createStore('gridfinity-tool-studio', 'uploads'));

const valid = (v: unknown): v is StoredUpload =>
  !!v && typeof v === 'object' && (v as StoredUpload).schema === SCHEMA && (v as StoredUpload).sheetViewJpeg instanceof Blob;

/** All stored uploads, oldest first. Entries that don't match the current schema are deleted. */
export async function loadUploads(): Promise<StoredUpload[]> {
  const all = await entries<string, unknown>(store());
  const out: StoredUpload[] = [];
  for (const [key, v] of all) {
    if (valid(v)) out.push(v);
    else await del(key, store());
  }
  return out.sort((a, b) => a.created - b.created);
}

/** Ids of the least recently used uploads beyond the first `max`. */
export function overflow(uploads: Pick<StoredUpload, 'id' | 'used'>[], max = MAX_UPLOADS): string[] {
  return [...uploads].sort((a, b) => a.used - b.used).slice(0, Math.max(0, uploads.length - max)).map((x) => x.id);
}

/** Store a new upload. Returns the ids of the uploads dropped to stay within MAX_UPLOADS. */
export async function saveUpload(u: UploadResult, now = Date.now()): Promise<string[]> {
  await set(u.id, { ...u, schema: SCHEMA, created: now, used: now } satisfies StoredUpload, store());
  const evict = overflow(await loadUploads());
  for (const id of evict) await del(id, store());
  return evict;
}

/** Mark an upload as just used, so it is the last to be dropped. */
export async function touchUpload(id: string, now = Date.now()): Promise<void> {
  const v = await get<unknown>(id, store());
  if (valid(v)) await set(id, { ...v, used: now }, store());
}

export async function removeUpload(id: string): Promise<void> {
  await del(id, store());
}
