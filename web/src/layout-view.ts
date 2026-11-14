// The Layout pane: a top-down view of the bin (cells, outer wall, usable inset) with every visible part's
// pocket and tool where its placement puts it, in bin mm (y up). Parts are dragged to move them and turned by
// a handle, with the part's axis snapping to 0/90/180/270° (Alt turns freely). Keys and a DOM part list do
// everything a drag does (WCAG 2.5.7); an aria-live line reports each change. The layout's warnings are listed
// under the caption and badge their parts; while a part is dragged, parts too close to it are ringed at once.
import { GRID, LIP_INSET, MIN_WALL } from './geometry/constants';
import { binSize, bounds, footprint, rotate, type Box2, type Ring, type Vec2 } from './geometry/pocket';
import { normalizeDeg, placeRing, type Layout, type Placement } from './kit';
import { clamp, MAX_CELLS } from './params';
import { isDark } from './trace';
import { centroid } from './vision/symmetry';
import type { LayoutWarning, PartTrace } from './worker/protocol';

/** Snap the axis within this many degrees of a multiple of 90, and let go of it beyond RELEASE. */
export const SNAP = 5;
export const RELEASE = 8;
/** How far beyond a part's extent its rotation handle sits (mm), and its radius and hit radius (css px). */
const HANDLE_GAP = 12;
const HANDLE_R = 7;
const HANDLE_HIT = 14;
/** Room kept around the bin (mm) so handles stay on screen, and for the switch and part list (css px). */
const MARGIN_MM = 16;
const PAD = { x: 24, top: 56, bottom: 52 };
const HISTORY = 50;

/** Canvas mapping: bin mm (y up) to css px is `(ox + x*s, oy - y*s)`; canvas pixels are css px times dpr. */
export interface ViewXf {
  s: number;
  ox: number;
  oy: number;
  dpr: number;
}

/** A bin-mm point in canvas (device) pixels. */
export function binToScreen([x, y]: Vec2, v: ViewXf): Vec2 {
  return [(v.ox + x * v.s) * v.dpr, (v.oy - y * v.s) * v.dpr];
}

/** A canvas (device) pixel in bin mm. */
export function screenToBin([px, py]: Vec2, v: ViewXf): Vec2 {
  return [(px / v.dpr - v.ox) / v.s, (v.oy - py / v.dpr) / v.s];
}

/** Even-odd point-in-polygon test. */
export function inRing([x, y]: Vec2, P: Ring): boolean {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i]!;
    const [xj, yj] = P[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Index of the topmost (last drawn) ring containing `pt`, or null. */
export function hitTest(pt: Vec2, rings: readonly Ring[]): number | null {
  for (let i = rings.length - 1; i >= 0; i--) {
    const b = bounds(rings[i]!);
    if (pt[0] < b.xmin || pt[0] > b.xmax || pt[1] < b.ymin || pt[1] > b.ymax) continue;
    if (inRing(pt, rings[i]!)) return i;
  }
  return null;
}

/** A part's angle with its axis (at `rot + axisDeg`) snapped to the nearest multiple of 90° when within SNAP,
 * or within RELEASE of `prev`, the multiple it is already snapped to. `snapped` is that multiple, or null. */
export function snapRot(rot: number, axisDeg: number, prev: number | null, free: boolean): { rot: number; snapped: number | null } {
  if (free) return { rot, snapped: null };
  const axis = rot + axisDeg;
  const target = Math.round(axis / 90) * 90 || 0; // no -0
  const limit = prev !== null && normalizeDeg(prev - target) === 0 ? RELEASE : SNAP;
  return Math.abs(axis - target) <= limit ? { rot: target - axisDeg, snapped: target } : { rot, snapped: null };
}

/** The placement turned to `rot` about the part-frame point `c`, which stays where it is in the bin. */
export function turnAbout(pl: Placement, c: Vec2, rot: number): Placement {
  const [px, py] = placeRing([c], pl)[0]!;
  const [rx, ry] = rotate([c], rot)[0]!;
  return { ...pl, rot, x: px - rx, y: py - ry };
}

/** A locked size as the worker cuts it: whole cells (half cells with half-grid feet), 1 step to MAX_CELLS. */
export function lockedCells(cells: readonly [number, number], halfGrid: boolean): [number, number] {
  const step = halfGrid ? 0.5 : 1;
  const n = (v: number) => clamp(Math.round((Number.isFinite(v) ? v : 1) / step) * step, step, MAX_CELLS);
  return [n(cells[0]), n(cells[1])];
}

/** The bin for a set of placed pockets: a locked size centred on the origin, else the size they need centred
 * on them; its outer rectangle, and the pockets' extent. */
function binOf(pockets: readonly Ring[], fillet: number, halfGrid: boolean, cells?: readonly [number, number]) {
  const b = bounds(pockets.flat());
  const [nx, ny] = cells ? lockedCells(cells, halfGrid) : footprint(pockets, fillet, halfGrid);
  const cx = cells ? 0 : (b.xmin + b.xmax) / 2;
  const cy = cells ? 0 : (b.ymin + b.ymax) / 2;
  return { nx, ny, cx, cy, w: binSize(nx), h: binSize(ny), pw: b.xmax - b.xmin, ph: b.ymax - b.ymin, b };
}

const apart = (a: Box2, b: Box2) => a.xmin > b.xmax || b.xmin > a.xmax || a.ymin > b.ymax || b.ymin > a.ymax;

/** Whether segments pq and rs cross or touch. */
function crosses([px, py]: Vec2, [qx, qy]: Vec2, [rx, ry]: Vec2, [sx, sy]: Vec2): boolean {
  const d1 = (sx - rx) * (py - ry) - (sy - ry) * (px - rx);
  const d2 = (sx - rx) * (qy - ry) - (sy - ry) * (qx - rx);
  const d3 = (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d4 = (qx - px) * (sy - py) - (qy - py) * (sx - px);
  return ((d1 <= 0 && d2 >= 0) || (d1 >= 0 && d2 <= 0)) && ((d3 <= 0 && d4 >= 0) || (d3 >= 0 && d4 <= 0))
    && Math.min(px, qx) <= Math.max(rx, sx) && Math.min(rx, sx) <= Math.max(px, qx)
    && Math.min(py, qy) <= Math.max(ry, sy) && Math.min(ry, sy) <= Math.max(py, qy);
}

/** Whether two grown pocket rings (PartTrace.grown, placed) meet: their pockets overlap or leave a wall
 * thinner than the minimum. The live check while dragging; the worker's checkLayout has the last word. */
export function tooClose(a: Ring, b: Ring): boolean {
  if (!a.length || !b.length) return false;
  const A = bounds(a);
  if (apart(A, bounds(b))) return false;
  if (inRing(a[0]!, b) || inRing(b[0]!, a)) return true;
  // only b's edges that reach a's box can cross one of a's
  for (let j = 0, l = b.length - 1; j < b.length; l = j++) {
    const r = b[l]!;
    const t = b[j]!;
    if (Math.max(r[0], t[0]) < A.xmin || Math.min(r[0], t[0]) > A.xmax
      || Math.max(r[1], t[1]) < A.ymin || Math.min(r[1], t[1]) > A.ymax) continue;
    for (let i = 0, k = a.length - 1; i < a.length; k = i++) if (crosses(a[k]!, a[i]!, r, t)) return true;
  }
  return false;
}

function rgba(col: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(col);
  if (!m) return col;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const trim = (v: number) => String(+v.toFixed(1));

/** What the view shows: a kit's parts (rings in the part frame) and its layout. */
export interface LayoutKit {
  /** The tool id; the undo history starts over when it changes. */
  id: string;
  parts: PartTrace[];
  layout: Layout;
  fillet: number;
  halfGrid: boolean;
  /** The worker's warnings for this layout. */
  warnings?: LayoutWarning[];
}

export interface LayoutHooks {
  /** A committed edit (drag released, key, undo). */
  change(layout: Layout): void;
  /** The bin's size while a drag is under way, before the worker has seen it. */
  live(f: { nx: number; ny: number; w: number; h: number }): void;
  /** The selected part changed (null: none). */
  select(id: string | null): void;
}

interface Drag {
  pointer: number;
  mode: 'move' | 'turn';
  part: string;
  start: Layout;
  from: Vec2;
  /** Turning: the pivot (bin mm) and the part-frame point it is. */
  pivot: Vec2;
  pivotPart: Vec2;
  snapped: number | null;
  moved: boolean;
}

export class LayoutView {
  private readonly ctx: CanvasRenderingContext2D;
  private kit: LayoutKit | null = null;
  private layout: Layout = { placements: [] };
  private selected: string | null = null;
  private drag: Drag | null = null;
  private xf: ViewXf = { s: 1, ox: 0, oy: 0, dpr: 1 };
  private past: Layout[] = [];
  private future: Layout[] = [];
  private listIds = '';
  /** Parts the worker warned about, and (while dragging) the parts too close to the dragged one. */
  private warned = new Set<string>();
  private close = new Set<string>();

  constructor(private readonly canvas: HTMLCanvasElement, private readonly list: HTMLElement,
    private readonly status: HTMLElement, private readonly warnList: HTMLElement, private readonly hooks: LayoutHooks) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.cancel(e));
    canvas.addEventListener('lostpointercapture', (e) => this.cancel(e));
    canvas.addEventListener('keydown', (e) => this.key(e));
    list.addEventListener('keydown', (e) => this.key(e));
    list.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('[role=option]');
      if (li) this.select(li.dataset.part!, true);
    });
  }

  /** Show a kit with its current layout. A drag under way keeps its own layout. */
  show(kit: LayoutKit): void {
    if (kit.id !== this.kit?.id) {
      this.past = [];
      this.future = [];
      this.selected = null;
    }
    this.kit = kit;
    if (!this.drag) this.layout = kit.layout;
    if (this.selected && !this.visible().some((pl) => pl.part === this.selected)) this.selected = null;
    this.syncWarnings();
    this.syncList();
    this.draw();
  }

  /** The selected part, or null. */
  get selection(): string | null {
    return this.selected;
  }

  /** Commit a layout made elsewhere (the inspector), with undo back to `prev`. */
  apply(layout: Layout, prev: Layout = this.layout): void {
    this.commit(layout, prev);
  }

  /** Show a layout made elsewhere while it is still being edited (a slider held), without undo. */
  preview(layout: Layout): void {
    if (this.drag) return;
    this.layout = layout;
    this.draw();
  }

  private visible(): Placement[] {
    return this.layout.placements.filter((pl) => !pl.hidden);
  }

  private trace(id: string): PartTrace | undefined {
    return this.kit?.parts.find((q) => q.id === id);
  }

  private num(id: string): number {
    return this.layout.placements.findIndex((pl) => pl.part === id) + 1;
  }

  private label(id: string): string {
    return `Part ${this.num(id)}`;
  }

  /** The worker's warnings as sentences under the caption, and the parts they name. */
  private syncWarnings(): void {
    const ws = this.kit?.warnings ?? [];
    const [nx, ny] = this.layout.cells ? lockedCells(this.layout.cells, !!this.kit?.halfGrid) : [0, 0];
    this.warned = new Set(ws.flatMap((w) => w.parts.filter((id): id is string => !!id)));
    this.warnList.replaceChildren(...ws.map((w) => {
      const li = document.createElement('li');
      const [a, b] = w.parts.map((id) => this.num(id ?? ''));
      li.textContent = w.kind === 'overlap' ? `Parts ${a} and ${b} overlap; their pockets will merge.`
        : w.kind === 'thin-wall' ? `The wall between parts ${a} and ${b} is thinner than ${MIN_WALL} mm.`
          : `Part ${a} sticks out of the locked ${nx}×${ny} bin.`;
      return li;
    }));
    this.warnList.hidden = !ws.length;
  }

  private describe(id: string): string {
    const pl = this.layout.placements.find((q) => q.part === id);
    return pl ? `${this.label(id)} at ${trim(pl.x)}, ${trim(pl.y)} mm, ${trim(pl.rot)}°` : '';
  }

  private say(text: string): void {
    this.status.textContent = text;
  }

  // ---- edits and history
  private commit(next: Layout, prev: Layout = this.layout): void {
    this.past.push(prev);
    if (this.past.length > HISTORY) this.past.shift();
    this.future = [];
    this.layout = next;
    this.hooks.change(next);
    this.syncList();
    this.draw();
  }

  /** Undo (or redo) the last layout edit, wherever it was made. */
  history(redo: boolean): void {
    this.undo(redo);
  }

  private undo(redo: boolean): void {
    const from = redo ? this.future : this.past;
    const to = redo ? this.past : this.future;
    const l = from.pop();
    if (!l) return;
    to.push(this.layout);
    this.layout = l;
    if (this.selected && !this.visible().some((pl) => pl.part === this.selected)) this.selected = null;
    this.hooks.change(l);
    this.syncList();
    this.draw();
    this.say(`${redo ? 'Redone' : 'Undone'}.${this.selected ? ' ' + this.describe(this.selected) : ''}`);
  }

  private edit(id: string, fn: (pl: Placement) => Placement): void {
    this.commit({ ...this.layout, placements: this.layout.placements.map((pl) => (pl.part === id ? fn(pl) : pl)) });
    this.say(this.describe(id));
  }

  /** The part-frame point a part turns about: its pocket's centroid. */
  private pivotOf(id: string): Vec2 {
    const t = this.trace(id);
    return t ? centroid(t.pocket) : [0, 0];
  }

  // ---- selection and the part list
  select(id: string | null, focusList = false): void {
    this.selected = id;
    this.syncList();
    if (focusList && id) this.list.querySelector<HTMLElement>(`[data-part="${CSS.escape(id)}"]`)?.focus();
    this.draw();
    this.say(id ? this.describe(id) : 'No part selected.');
    this.hooks.select(id);
  }

  private syncList(): void {
    const vis = this.visible();
    const ids = vis.map((pl) => pl.part).join('\n');
    if (ids !== this.listIds) {
      this.listIds = ids;
      this.list.replaceChildren(...vis.map((pl) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.dataset.part = pl.part;
        li.textContent = this.label(pl.part);
        return li;
      }));
    }
    const current = this.selected ?? vis[0]?.part;
    for (const li of this.list.querySelectorAll<HTMLElement>('[role=option]')) {
      li.setAttribute('aria-selected', String(li.dataset.part === this.selected));
      li.tabIndex = li.dataset.part === current ? 0 : -1;
      li.classList.toggle('warned', this.warned.has(li.dataset.part!));
    }
  }

  // ---- keyboard (canvas and part list)
  private key(e: KeyboardEvent): void {
    const inList = e.currentTarget === this.list;
    const vis = this.visible();
    const id = this.selected;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      this.undo(e.shiftKey);
    } else if (mod) {
      return;
    } else if (e.key === 'Tab') {
      // cycle through the parts, then let focus move on (no keyboard trap)
      const i = vis.findIndex((pl) => pl.part === id);
      const j = id === null ? (e.shiftKey ? vis.length - 1 : 0) : i + (e.shiftKey ? -1 : 1);
      if (j < 0 || j >= vis.length) return;
      this.select(vis[j]!.part, inList);
    } else if (e.key === 'Escape') {
      if (id === null) return;
      this.select(null);
    } else if (id === null) {
      return;
    } else if (e.key.startsWith('Arrow')) {
      const d = e.shiftKey ? 10 : 1;
      const [dx, dy] = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }[e.key] ?? [0, 0];
      this.edit(id, (pl) => ({ ...pl, x: pl.x + dx!, y: pl.y + dy! }));
    } else if (e.key === '[' || e.key === ']') {
      const c = this.pivotOf(id);
      this.edit(id, (pl) => turnAbout(pl, c, normalizeDeg(pl.rot + (e.key === ']' ? 90 : -90))));
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (vis.length < 2) {
        this.say('A bin needs at least one part.');
      } else {
        const label = this.label(id);
        this.select(null);
        this.edit(id, (pl) => ({ ...pl, hidden: true }));
        this.say(`${label} removed. Restore it under Hidden parts.`);
      }
    } else {
      return;
    }
    e.preventDefault();
  }

  // ---- pointer: drag to move, drag the handle to turn
  private point(e: PointerEvent): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    return screenToBin([(e.clientX - r.left) * this.xf.dpr, (e.clientY - r.top) * this.xf.dpr], this.xf);
  }

  private down(e: PointerEvent): void {
    if (this.drag || !e.isPrimary || e.button !== 0 || !this.kit) return;
    e.preventDefault(); // no text selection or touch scrolling; focus by hand since mouse events are suppressed
    this.canvas.focus({ preventScroll: true });
    const at = this.point(e);
    const handle = this.selected ? this.handle(this.selected) : null;
    let mode: Drag['mode'] = 'move';
    let id: string;
    if (handle && Math.hypot(at[0] - handle.at[0], at[1] - handle.at[1]) * this.xf.s <= HANDLE_HIT) {
      mode = 'turn';
      id = this.selected!;
    } else {
      const vis = this.visible();
      const i = hitTest(at, vis.map((pl) => placeRing(this.trace(pl.part)?.pocket ?? [], pl)));
      if (i === null) {
        if (this.selected) this.select(null);
        return;
      }
      id = vis[i]!.part;
      if (id !== this.selected) this.select(id);
    }
    const pl = this.layout.placements.find((q) => q.part === id)!;
    const pivotPart = this.pivotOf(id);
    this.drag = {
      pointer: e.pointerId, mode, part: id, start: this.layout, from: at, pivotPart,
      pivot: placeRing([pivotPart], pl)[0]!, snapped: null, moved: false,
    };
    this.canvas.setPointerCapture(e.pointerId);
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    const at = this.point(e);
    const pl0 = d.start.placements.find((q) => q.part === d.part)!;
    let pl: Placement;
    if (d.mode === 'move') {
      pl = { ...pl0, x: pl0.x + at[0] - d.from[0], y: pl0.y + at[1] - d.from[1] };
    } else {
      const [px, py] = d.pivot;
      const turn = (Math.atan2(at[1] - py, at[0] - px) - Math.atan2(d.from[1] - py, d.from[0] - px)) * 180 / Math.PI;
      const s = snapRot(normalizeDeg(pl0.rot + turn), this.trace(d.part)?.axisDeg ?? 0, d.snapped, e.altKey);
      d.snapped = s.snapped;
      pl = turnAbout(pl0, d.pivotPart, normalizeDeg(s.rot));
    }
    d.moved = true;
    this.layout = { ...d.start, placements: d.start.placements.map((q) => (q.part === d.part ? pl : q)) };
    this.close = this.tooCloseTo(d.part);
    const kit = this.kit!;
    const bin = binOf(this.pockets(), kit.fillet, kit.halfGrid, this.layout.cells);
    this.hooks.live({ nx: bin.nx, ny: bin.ny, w: bin.pw, h: bin.ph });
    this.draw();
  }

  private up(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    this.drag = null; // before the capture is released, so lostpointercapture doesn't revert
    this.close.clear();
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (d.moved) {
      this.commit(this.layout, d.start);
      this.say(this.describe(d.part));
    } else this.draw();
  }

  /** A cancelled or interrupted drag puts the part back. */
  private cancel(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    this.drag = null;
    this.close.clear();
    this.layout = d.start;
    if (this.kit) {
      const bin = binOf(this.pockets(), this.kit.fillet, this.kit.halfGrid, this.layout.cells);
      this.hooks.live({ nx: bin.nx, ny: bin.ny, w: bin.pw, h: bin.ph });
    }
    this.draw();
  }

  // ---- geometry
  private pockets(): Ring[] {
    return this.visible().map((pl) => placeRing(this.trace(pl.part)?.pocket ?? [], pl)).filter((P) => P.length);
  }

  /** A part's grown ring where its placement puts it (empty without one). */
  private grown(pl: Placement): Ring {
    const g = this.trace(pl.part)?.grown;
    return g ? placeRing(g, pl) : [];
  }

  /** The parts too close to `id`, and it when any is, by their grown rings. */
  private tooCloseTo(id: string): Set<string> {
    const vis = this.visible();
    const me = vis.find((pl) => pl.part === id);
    const out = new Set<string>();
    const a = me ? this.grown(me) : [];
    for (const pl of vis) if (pl.part !== id && tooClose(a, this.grown(pl))) out.add(pl.part).add(id);
    return out;
  }

  /** The selected part's rotation handle (bin mm), the point its stem starts from and the part's axis. */
  private handle(id: string): { at: Vec2; stem: Vec2; c: Vec2; dir: Vec2; half: number } | null {
    const pl = this.layout.placements.find((q) => q.part === id);
    const t = this.trace(id);
    if (!pl || !t) return null;
    const c = placeRing([this.pivotOf(id)], pl)[0]!;
    const dir = rotate([[0, 1]], pl.rot)[0]!;
    const P = placeRing(t.pocket, pl);
    const half = Math.max(...P.map(([x, y]) => (x - c[0]) * dir[0] + (y - c[1]) * dir[1]));
    const along = (k: number): Vec2 => [c[0] + dir[0] * k, c[1] + dir[1] * k];
    return { at: along(half + HANDLE_GAP), stem: along(half), c, dir, half };
  }

  draw(): void {
    const { canvas, ctx } = this;
    const r = canvas.parentElement!.getBoundingClientRect();
    const dpr = devicePixelRatio;
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const kit = this.kit;
    const pockets = this.pockets();
    if (!kit || !pockets.length) return;
    const bin = binOf(pockets, kit.fillet, kit.halfGrid, this.layout.cells);
    // fit the bin and the parts (plus room for the handles) to the pane below the warnings; a drag keeps the
    // scale it started with
    if (!this.drag) {
      const x0 = Math.min(bin.cx - bin.w / 2, bin.b.xmin) - MARGIN_MM;
      const x1 = Math.max(bin.cx + bin.w / 2, bin.b.xmax) + MARGIN_MM;
      const y0 = Math.min(bin.cy - bin.h / 2, bin.b.ymin) - MARGIN_MM;
      const y1 = Math.max(bin.cy + bin.h / 2, bin.b.ymax) + MARGIN_MM;
      const top = PAD.top + (this.warnList.hidden ? 0 : this.warnList.offsetHeight + 8);
      const s = Math.max(1e-3, Math.min((r.width - 2 * PAD.x) / (x1 - x0), (r.height - top - PAD.bottom) / (y1 - y0)));
      const xc = r.width / 2;
      const yc = top + (r.height - top - PAD.bottom) / 2;
      this.xf = { s, ox: xc - ((x0 + x1) / 2) * s, oy: yc + ((y0 + y1) / 2) * s, dpr };
      canvas.dataset.scale = s.toFixed(4);
    }
    const xf = this.xf;
    const S = (p: Vec2) => binToScreen(p, xf);
    const k = xf.s * dpr; // canvas px per mm
    const cs = getComputedStyle(document.documentElement);
    const col = (name: string) => cs.getPropertyValue(name).trim();
    const cTool = col('--trace-tool');
    const cPocket = col('--trace-pocket');
    const cAxis = col('--trace-axis');
    const halo = col('--bg-canvas');
    const path = (P: Ring) => {
      ctx.beginPath();
      P.forEach((q, i) => (i ? ctx.lineTo(...S(q)) : ctx.moveTo(...S(q))));
      ctx.closePath();
    };
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // the bin: outer wall, cells, and the area a pocket may use (dashed)
    const [bx, by] = S([bin.cx - bin.w / 2, bin.cy + bin.h / 2]);
    const binRect = () => {
      ctx.beginPath();
      ctx.roundRect(bx, by, bin.w * k, bin.h * k, 3.75 * k);
    };
    ctx.save();
    ctx.shadowColor = isDark() ? 'rgba(0,0,0,.5)' : 'rgba(0,0,0,.12)';
    ctx.shadowBlur = 14 * dpr;
    ctx.shadowOffsetY = 3 * dpr;
    binRect();
    ctx.fillStyle = col('--bg-window');
    ctx.fill();
    ctx.restore();
    binRect();
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = col('--label-3');
    ctx.stroke();
    ctx.save();
    binRect();
    ctx.clip();
    const cell = kit.halfGrid ? GRID / 2 : GRID;
    ctx.beginPath();
    const x0 = bin.cx - (bin.nx * GRID) / 2;
    const y0 = bin.cy - (bin.ny * GRID) / 2;
    for (let x = x0 + cell; x < x0 + bin.nx * GRID - 1e-6; x += cell) {
      ctx.moveTo(...S([x, bin.cy - bin.h / 2]));
      ctx.lineTo(...S([x, bin.cy + bin.h / 2]));
    }
    for (let y = y0 + cell; y < y0 + bin.ny * GRID - 1e-6; y += cell) {
      ctx.moveTo(...S([bin.cx - bin.w / 2, y]));
      ctx.lineTo(...S([bin.cx + bin.w / 2, y]));
    }
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = col('--separator');
    ctx.stroke();
    const inset = kit.fillet + LIP_INSET + MIN_WALL;
    const [ix, iy] = S([bin.cx - bin.w / 2 + inset, bin.cy + bin.h / 2 - inset]);
    ctx.beginPath();
    ctx.roundRect(ix, iy, (bin.w - 2 * inset) * k, (bin.h - 2 * inset) * k, 2 * dpr);
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeStyle = col('--label-3');
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.restore();

    // snap guide: the snapped axis, solid, across the bin and beyond it
    const d = this.drag;
    const g = d?.mode === 'turn' && d.snapped !== null ? this.handle(d.part) : null;
    if (g) {
      const L = bin.w + bin.h;
      const [ux, uy] = rotate([[0, L]], d!.snapped!)[0]!;
      ctx.beginPath();
      ctx.moveTo(...S([g.c[0] - ux, g.c[1] - uy]));
      ctx.lineTo(...S([g.c[0] + ux, g.c[1] + uy]));
      ctx.lineWidth = 1.2 * dpr;
      ctx.strokeStyle = rgba(cAxis, 0.8);
      ctx.stroke();
    }

    // while dragging: the grown rings of parts too close together, dashed
    const vis = this.visible();
    canvas.dataset.close = [...this.close].join(' ');
    canvas.dataset.parts = vis.map((pl) => {
      const c = S(placeRing([this.pivotOf(pl.part)], pl)[0]!);
      return `${pl.part} ${(c[0] / dpr).toFixed(1)} ${(c[1] / dpr).toFixed(1)}`;
    }).join(', ');
    for (const pl of vis) {
      if (!this.close.has(pl.part)) continue;
      path(this.grown(pl));
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.lineWidth = 1.6 * dpr;
      ctx.strokeStyle = col('--destructive');
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // parts: pockets then tools, the selected one emphasised
    vis.forEach((pl) => {
      const t = this.trace(pl.part);
      if (!t) return;
      const sel = pl.part === this.selected;
      path(placeRing(t.pocket, pl));
      ctx.lineWidth = 4 * dpr;
      ctx.strokeStyle = halo;
      ctx.stroke();
      ctx.fillStyle = rgba(cPocket, sel ? 0.26 : 0.14);
      ctx.fill();
      ctx.lineWidth = (sel ? 2.6 : 1.8) * dpr;
      ctx.strokeStyle = cPocket;
      ctx.stroke();
    });
    vis.forEach((pl) => {
      const t = this.trace(pl.part);
      if (!t) return;
      path(placeRing(t.tool, pl));
      ctx.lineWidth = 3.5 * dpr;
      ctx.strokeStyle = halo;
      ctx.stroke();
      ctx.lineWidth = 1.6 * dpr;
      ctx.strokeStyle = cTool;
      ctx.stroke();
    });

    // a warning badge at the top right of every part a warning names
    for (const pl of vis) {
      const t = this.trace(pl.part);
      if (!t || this.drag || !this.warned.has(pl.part)) continue;
      const b = bounds(placeRing(t.pocket, pl));
      const [x, y] = S([b.xmax, b.ymax]);
      ctx.beginPath();
      ctx.arc(x, y, 7 * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = col('--orange');
      ctx.fill();
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = halo;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${10 * dpr}px ${col('--font')}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', x, y + 0.5 * dpr);
    }

    // the selected part's axis (along which it snaps) and its rotation handle
    const h = this.selected ? this.handle(this.selected) : null;
    canvas.dataset.handle = h ? S(h.at).map((v) => (v / dpr).toFixed(1)).join(' ') : '';
    if (h && this.selected) {
      const a = this.trace(this.selected)?.axisDeg ?? 0;
      const ad = rotate([h.dir], a)[0]!;
      const e = h.half + 4;
      ctx.beginPath();
      ctx.moveTo(...S([h.c[0] - ad[0] * e, h.c[1] - ad[1] * e]));
      ctx.lineTo(...S([h.c[0] + ad[0] * e, h.c[1] + ad[1] * e]));
      ctx.lineWidth = 4 * dpr;
      ctx.strokeStyle = halo;
      ctx.stroke();
      ctx.setLineDash([7 * dpr, 4 * dpr]);
      ctx.lineWidth = 1.8 * dpr;
      ctx.strokeStyle = cAxis;
      ctx.stroke();
      ctx.setLineDash([]);
      const [sx, sy] = S(h.stem);
      const [hx, hy] = S(h.at);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(hx, hy);
      ctx.lineWidth = 1.2 * dpr;
      ctx.strokeStyle = col('--label-2');
      ctx.stroke();
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.25)';
      ctx.shadowBlur = 4 * dpr;
      ctx.shadowOffsetY = 1 * dpr;
      ctx.beginPath();
      ctx.arc(hx, hy, HANDLE_R * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = col('--thumb');
      ctx.fill();
      ctx.restore();
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = cTool;
      ctx.stroke();
      // a turn arrow inside the handle
      ctx.beginPath();
      ctx.arc(hx, hy, 3.4 * dpr, -Math.PI * 0.9, Math.PI * 0.4);
      ctx.lineWidth = 1.2 * dpr;
      ctx.stroke();
    }
  }
}
