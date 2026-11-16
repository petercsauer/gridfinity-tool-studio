// The Outline pane: one part's outline as an editable path, over the photo it was traced from. Points sit on
// the outline (squares are corners, circles smooth); the selected point shows its handles. Drag a point, a
// handle or the outline itself; double-click a point to switch it between corner and smooth, or the outline to
// add a point. The traced outline stays drawn faintly and is what the Detail slider and deleting a point refit
// to. An edit that would make the outline cross itself is drawn red and undone when let go. With Symmetric on,
// the outline is a mirrored pair about the part's axis (path/mirror.ts): either side can be edited and the other
// follows; the two points on the axis slide along it.
import type { Ring, Vec2 } from './geometry/pocket';
import type { Placement } from './kit';
import { flatten, flattenCubic, insertAnchor, nearest, nearestOnCubic, segment, straightenSegment, type BezierPath } from './path/bezier';
import { bendSegment, deleteAnchor, isValid, moveAnchor, moveHandle, refit, roundCorner, toggleKind } from './path/edit';
import { FIT } from './path/fit';
import {
  fitHalf, fullFromHalf, halfFromFull, mirrorBend, mirrorDelete, mirrorInsert, mirrorMoveAnchor, mirrorMoveHandle,
  mirrorRound, mirrorStraighten, mirrorToggle, type Axis,
} from './path/mirror';
import type { PartTrace } from './worker/protocol';

/** Pick distances on screen (css px). */
const HIT_POINT = 9;
const HIT_HANDLE = 8;
const HIT_LINE = 7;

export interface OutlineKit {
  /** The tool id; the fitted outline is made afresh when it or the part changes. */
  tool: string;
  part: PartTrace;
  placement: Placement;
  label: string;
  sheetImage: string;
  sheetBox: [number, number, number, number];
}

export interface OutlineHooks {
  /** A committed edit: the part's new outline (and whether it is a mirrored pair), or undefined to go back to
   * the traced one. */
  change(path: BezierPath | undefined, said: string, mirrored?: boolean): void;
  undo(redo: boolean): void;
}

type Pick = { kind: 'point'; i: number } | { kind: 'handle'; i: number; side: 'in' | 'out' } | { kind: 'line'; i: number; t: number };

interface Drag {
  pointer: number;
  pick: Pick;
  start: BezierPath;
  startHalf: BezierPath | null;
  from: Vec2;
  moved: boolean;
}

/** Screen = s * part + o (canvas px). */
interface Xf { s: number; ox: number; oy: number; dpr: number }

export class OutlineView {
  private readonly ctx: CanvasRenderingContext2D;
  private kit: OutlineKit | null = null;
  /** The path shown: the part's edited one, or (until it is edited) one fitted to the trace. */
  private path: BezierPath | null = null;
  private fittedFor = '';
  private tolerance = FIT.tolerance;
  private selected: Pick | null = null;
  private drag: Drag | null = null;
  private invalid = false;
  private xf: Xf = { s: 1, ox: 0, oy: 0, dpr: 1 };
  private image = new Image();
  private imageUrl = '';
  /** Symmetric editing: the part's axis, the outline's half (this.path is it with its mirror) and the half's ring
   * with the axis (what deleting a point refits to). Null when the outline is edited as a whole. */
  private axis: Axis | null = null;
  private half: BezierPath | null = null;
  private halfTrace: Ring | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly ui: {
    detail: HTMLInputElement; detailValue: HTMLElement; count: HTMLElement; status: HTMLElement;
    kind: HTMLButtonElement; straighten: HTMLButtonElement; remove: HTMLButtonElement; reset: HTMLButtonElement;
    round: HTMLButtonElement; radius: HTMLInputElement;
  }, private readonly hooks: OutlineHooks) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.cancel(e));
    canvas.addEventListener('lostpointercapture', (e) => this.cancel(e));
    canvas.addEventListener('dblclick', (e) => this.double(e));
    canvas.addEventListener('keydown', (e) => this.key(e));
    ui.detail.addEventListener('input', () => this.detail(false));
    ui.detail.addEventListener('change', () => this.detail(true));
    ui.kind.addEventListener('click', () => this.toggleSelected());
    ui.straighten.addEventListener('click', () => this.straightenSelected());
    ui.remove.addEventListener('click', () => this.removeSelected());
    ui.round.addEventListener('click', () => this.roundSelected());
    ui.reset.addEventListener('click', () => {
      if (!this.kit?.placement.path) return;
      this.path = null;
      this.fittedFor = '';
      this.selected = null;
      this.hooks.change(undefined, `${this.kit.label}: back to the traced outline.`);
    });
  }

  /** Show a part (null: none). An edit under way keeps its own path. */
  show(kit: OutlineKit | null): void {
    const key = kit ? `${kit.tool}/${kit.part.id}` : '';
    if (key !== (this.kit ? `${this.kit.tool}/${this.kit.part.id}` : '')) this.selected = null;
    this.kit = kit;
    if (kit && kit.sheetImage !== this.imageUrl) {
      this.imageUrl = kit.sheetImage;
      const img = new Image();
      img.onload = () => {
        if (this.image === img) this.draw();
      };
      img.src = kit.sheetImage;
      this.image = img;
    }
    if (!this.drag) this.load(kit, key);
    // an undo or redo can leave fewer points than the selection's index
    const n = this.path?.anchors.length ?? 0;
    if (this.selected && this.selected.i >= n) this.selected = null;
    this.sync();
    this.draw();
  }

  /** The path to edit: a symmetric part's mirrored pair (its edited one, or one fitted to its half), else the edited
   * outline or one fitted to the whole trace. */
  private load(kit: OutlineKit | null, key: string): void {
    this.axis = this.half = this.halfTrace = null;
    if (!kit) {
      this.path = null;
      return;
    }
    const pl = kit.placement;
    if (pl.sym && (!pl.path || pl.pathSym)) {
      const fit = this.fittedHalf(key);
      const half = pl.path ? halfFromFull(pl.path) : fit?.half ?? null;
      if (fit && half) {
        this.axis = kit.part.mirror;
        this.half = half;
        this.halfTrace = fit.ring;
        this.path = fullFromHalf(this.axis, half);
        return;
      }
      this.say('This outline crosses its mirror axis more than twice, so it is edited as a whole.');
    }
    this.path = pl.path ?? this.fitted(key);
  }

  /** The traced symmetric outline's half fitted at the slider's tolerance (cached like `fitted`). */
  private fittedHalfFor = '';
  private fittedHalfValue: { half: BezierPath; ring: Ring } | null = null;
  private fittedHalf(key: string): { half: BezierPath; ring: Ring } | null {
    const traced = this.kit!.part.traced;
    const k = `${key}@${this.tolerance}`;
    if (k !== this.fittedHalfFor || traced !== this.fittedTrace) {
      this.fittedHalfValue = fitHalf(this.kit!.part.mirror, traced, this.tolerance);
      this.fittedHalfFor = k;
      this.fittedTrace = traced;
      this.fittedFor = '';
    }
    return this.fittedHalfValue;
  }

  /** The outline fitted to the trace at the slider's tolerance (cached per part, trace and tolerance: the trace
   * changes with Symmetric). */
  private fittedTrace: Ring | null = null;
  private fittedPath: BezierPath | null = null;
  private fitted(key: string): BezierPath {
    const k = `${key}@${this.tolerance}`;
    const traced = this.kit!.part.traced;
    if (k !== this.fittedFor || !this.fittedPath || traced !== this.fittedTrace) {
      this.fittedPath = refit(traced, this.tolerance);
      this.fittedFor = k;
      this.fittedTrace = traced;
      this.fittedHalfFor = '';
    }
    return this.fittedPath;
  }

  private say(text: string): void {
    this.ui.status.textContent = text;
  }

  /** Commit `next` as the part's outline; in symmetric editing, a new half (the outline is it and its mirror). */
  private commit(next: BezierPath | null, said: string, half?: BezierPath): void {
    if (this.axis && half) next = fullFromHalf(this.axis, half);
    if (!next || !isValid(next)) {
      this.say(next ? 'That would make the outline cross itself, so it was left as it was.' : said);
      this.draw();
      return;
    }
    if (this.axis && half) this.half = half;
    this.path = next;
    this.hooks.change(next, said, !!this.axis);
    this.say(said);
    this.sync();
    this.draw();
  }

  // ---- the bar: detail slider, point count and buttons
  private detail(commit: boolean): void {
    if (!this.kit) return;
    this.tolerance = +this.ui.detail.value;
    this.ui.detailValue.textContent = `${this.tolerance.toFixed(2)} mm`;
    this.selected = null;
    const fit = this.axis ? fitHalf(this.axis, this.kit.part.traced, this.tolerance) : null;
    const next = fit ? fullFromHalf(this.axis!, fit.half) : refit(this.kit.part.traced, this.tolerance);
    if (commit) {
      if (fit) this.halfTrace = fit.ring;
      this.commit(next, `Refitted within ${this.tolerance.toFixed(2)} mm of the trace: ${next.anchors.length} points.`, fit?.half);
    } else {
      this.path = next;
      if (fit) this.half = fit.half;
      this.sync();
      this.draw();
    }
  }

  private sync(): void {
    const p = this.path;
    const sel = this.selected;
    this.ui.count.textContent = p ? `${p.anchors.length} points` : '';
    const point = sel && sel.kind !== 'line' ? p?.anchors[sel.i] : undefined;
    this.ui.kind.disabled = !point;
    this.ui.kind.textContent = point?.kind === 'smooth' ? 'Make corner' : 'Make smooth';
    this.ui.straighten.disabled = !sel;
    this.ui.remove.disabled = !point || (p?.anchors.length ?? 0) <= 3;
    this.ui.reset.disabled = !this.kit?.placement.path;
    this.ui.round.disabled = point?.kind !== 'corner';
    this.ui.detail.disabled = !this.kit;
  }

  // ---- edits on the selection (buttons and keys)
  private pointIndex(): number | null {
    return this.selected && this.selected.kind !== 'line' ? this.selected.i : null;
  }

  private toggleSelected(): void {
    const i = this.pointIndex();
    if (i === null || !this.path) return;
    if (this.axis && this.half) {
      const half = mirrorToggle(this.axis, this.half, i);
      this.commit(null, `Point ${i + 1} is now ${fullFromHalf(this.axis, half).anchors[i]!.kind}.`, half);
      return;
    }
    const next = toggleKind(this.path, i);
    this.commit(next, `Point ${i + 1} is now ${next.anchors[i]!.kind}.`);
  }

  /** Straighten the selected segment, or the one after the selected point. */
  private straightenSelected(): void {
    if (!this.selected || !this.path) return;
    const i = this.selected.i;
    if (this.axis && this.half) this.commit(null, `Segment ${i + 1} is straight.`, mirrorStraighten(this.axis, this.half, i));
    else this.commit(straightenSegment(this.path, i), `Segment ${i + 1} is straight.`);
  }

  private roundSelected(): void {
    const i = this.pointIndex();
    if (i === null || !this.path || this.path.anchors[i]!.kind !== 'corner') return;
    const r = Math.min(20, Math.max(0.5, +this.ui.radius.value || 2));
    const m = this.axis && this.half ? mirrorRound(this.axis, this.half, i, r) : null;
    const { path: next, radius } = m ? { path: null, radius: m.radius } : roundCorner(this.path, i, r);
    if (!radius) {
      this.say(m ? `Point ${i + 1} is on the mirror axis or barely turns, so it isn't rounded.` : `Point ${i + 1} barely turns, so there is no corner to round.`);
      return;
    }
    this.selected = null;
    const used = +radius.toFixed(2);
    this.commit(next, used < r - 0.005 ? `Point ${i + 1} rounded to ${used} mm, as much as its sides allow.` : `Point ${i + 1} rounded to ${r} mm.`, m?.half);
  }

  /** A point added on the selected segment where it was picked, or halfway along the one after the selected
   * point; the shape doesn't change. */
  private addPoint(): void {
    const sel = this.selected;
    if (!sel || !this.path) {
      this.say('Pick a point or a stretch of the outline first, or double-click the outline where a point should go.');
      return;
    }
    this.insertAt(sel.i, sel.kind === 'line' ? sel.t : 0.5);
  }

  /** A point added on segment i at t (and its mirror, in symmetric editing), then selected. */
  private insertAt(i: number, t: number): void {
    if (!this.path) return;
    if (this.axis && this.half) {
      const { half, index } = mirrorInsert(this.axis, this.half, i, t);
      this.selected = { kind: 'point', i: index };
      this.commit(null, `Point added, and its mirror: ${2 * half.anchors.length - 2} points.`, half);
      return;
    }
    const { path, index } = insertAnchor(this.path, i, t);
    this.selected = { kind: 'point', i: index };
    this.commit(path, `Point added: ${path.anchors.length} points.`);
  }

  private removeSelected(): void {
    const i = this.pointIndex();
    if (i === null || !this.path || !this.kit) return;
    if (this.path.anchors.length <= 3) {
      this.say('An outline needs at least three points.');
      return;
    }
    if (this.axis && this.half && this.halfTrace) {
      const half = mirrorDelete(this.axis, this.half, i, this.halfTrace);
      if (!half) {
        this.say('The points on the mirror axis stay; drag one along the axis to move it.');
        return;
      }
      this.selected = null;
      this.commit(null, `Point ${i + 1} and its mirror removed; the outline was refitted to the trace there.`, half);
      return;
    }
    this.selected = null;
    this.commit(deleteAnchor(this.path, i, this.kit.part.traced), `Point ${i + 1} removed; the outline was refitted to the trace there.`);
  }

  // ---- keyboard
  private key(e: KeyboardEvent): void {
    const p = this.path;
    if (!p) return;
    const mod = e.metaKey || e.ctrlKey;
    const n = p.anchors.length;
    const i = this.pointIndex();
    if (mod && e.key.toLowerCase() === 'z') {
      this.hooks.undo(e.shiftKey);
    } else if (mod) {
      return;
    } else if (e.key === 'Tab') {
      // step through the points, then let focus move on
      const j = i === null ? (e.shiftKey ? n - 1 : 0) : i + (e.shiftKey ? -1 : 1);
      if (j < 0 || j >= n) return;
      this.selected = { kind: 'point', i: j };
      this.say(`Point ${j + 1} of ${n}, ${p.anchors[j]!.kind}.`);
      this.sync();
      this.draw();
    } else if (e.key === 'Escape') {
      if (!this.selected) return;
      this.selected = null;
      this.sync();
      this.draw();
    } else if (e.key.startsWith('Arrow') && i !== null) {
      const d = e.shiftKey ? 1 : 0.1;
      const [dx, dy] = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[e.key] ?? [0, 0];
      const a = p.anchors[i]!.p;
      const to: Vec2 = [a[0] + dx!, a[1] + dy!];
      if (this.axis && this.half) this.commit(null, `Point ${i + 1} moved.`, mirrorMoveAnchor(this.axis, this.half, i, to, false));
      else this.commit(moveAnchor(p, i, to, false), `Point ${i + 1} moved.`);
    } else if ((e.key === 'Delete' || e.key === 'Backspace' || e.key === 'd' || e.key === 'D') && i !== null) {
      this.removeSelected();
    } else if (e.key === 'a' || e.key === 'A') {
      this.addPoint();
    } else if (e.key === '-' || e.key === '_' || e.key === '=' || e.key === '+') {
      // less detail (a looser fit, fewer points) or more
      const el = this.ui.detail;
      const step = +el.step || 0.05;
      const v = Math.min(+el.max, Math.max(+el.min, +el.value + (e.key === '-' || e.key === '_' ? step : -step)));
      if (v === +el.value) return;
      el.value = String(+v.toFixed(2));
      this.detail(true);
    } else if (e.key === 'c' || e.key === 'C') {
      this.toggleSelected();
    } else if (e.key === 's' || e.key === 'S') {
      this.straightenSelected();
    } else if (e.key === 'r' || e.key === 'R') {
      this.roundSelected();
    } else {
      return;
    }
    e.preventDefault();
  }

  // ---- pointer
  private toScreen([x, y]: Vec2): Vec2 {
    return [this.xf.ox + x * this.xf.s, this.xf.oy + y * this.xf.s];
  }

  private toPart(e: { clientX: number; clientY: number }): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    const sx = (e.clientX - r.left) * this.xf.dpr, sy = (e.clientY - r.top) * this.xf.dpr;
    return [(sx - this.xf.ox) / this.xf.s, (sy - this.xf.oy) / this.xf.s];
  }

  /** What is under `at` (part mm): the selected point's handles first, then points, then the outline. */
  private pick(at: Vec2): Pick | null {
    const p = this.path;
    if (!p) return null;
    const px = (mm: number) => (mm * this.xf.s) / this.xf.dpr;
    const d = (a: Vec2) => px(Math.hypot(a[0] - at[0], a[1] - at[1]));
    const i = this.pointIndex();
    if (i !== null) {
      const a = p.anchors[i]!;
      for (const side of ['in', 'out'] as const) {
        const h = side === 'in' ? a.hin : a.hout;
        if (Math.hypot(h[0], h[1]) > 1e-9 && d([a.p[0] + h[0], a.p[1] + h[1]]) <= HIT_HANDLE) return { kind: 'handle', i, side };
      }
    }
    let best: Pick | null = null, bestD = HIT_POINT;
    p.anchors.forEach((a, k) => {
      if (d(a.p) <= bestD) { bestD = d(a.p); best = { kind: 'point', i: k }; }
    });
    if (best) return best;
    const r = nearest(p, at, 24);
    return px(r.dist) <= HIT_LINE ? { kind: 'line', i: r.seg, t: r.t } : null;
  }

  private down(e: PointerEvent): void {
    if (this.drag || !e.isPrimary || e.button !== 0 || !this.path) return;
    e.preventDefault();
    this.canvas.focus({ preventScroll: true });
    const at = this.toPart(e);
    const hit = this.pick(at);
    if (!hit) {
      this.selected = null;
      this.sync();
      this.draw();
      return;
    }
    if (hit.kind !== 'handle') this.selected = hit.kind === 'line' ? { ...hit } : hit;
    this.drag = { pointer: e.pointerId, pick: hit, start: this.path, startHalf: this.half, from: at, moved: false };
    this.canvas.setPointerCapture(e.pointerId);
    this.sync();
    this.draw();
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    const at = this.toPart(e);
    if (!d.moved && Math.hypot(at[0] - d.from[0], at[1] - d.from[1]) * this.xf.s / this.xf.dpr < 2) return;
    d.moved = true;
    const pk = d.pick;
    const s = d.start;
    const to: Vec2 = pk.kind === 'point' ? [s.anchors[pk.i]!.p[0] + at[0] - d.from[0], s.anchors[pk.i]!.p[1] + at[1] - d.from[1]] : at;
    if (this.axis && d.startHalf) {
      const h = d.startHalf;
      this.half = pk.kind === 'point' ? mirrorMoveAnchor(this.axis, h, pk.i, to, !e.altKey)
        : pk.kind === 'handle' ? mirrorMoveHandle(this.axis, h, pk.i, pk.side, to, e.altKey)
          : mirrorBend(this.axis, h, pk.i, pk.t, to);
      this.path = fullFromHalf(this.axis, this.half);
    } else {
      this.path = pk.kind === 'point' ? moveAnchor(s, pk.i, to, !e.altKey)
        : pk.kind === 'handle' ? moveHandle(s, pk.i, pk.side, to, e.altKey)
          : bendSegment(s, pk.i, pk.t, to);
    }
    this.invalid = !isValid(this.path);
    this.say(this.invalid ? 'The outline would cross itself; let go to put it back.' : '');
    this.draw();
  }

  private up(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    const next = this.path!;
    const nextHalf = this.half;
    const bad = this.invalid;
    this.invalid = false;
    if (!d.moved) {
      this.draw();
      return;
    }
    this.path = d.start;
    this.half = d.startHalf;
    if (bad) {
      this.say('The outline would have crossed itself, so it was put back.');
      this.draw();
      return;
    }
    const pk = d.pick;
    this.commit(next, pk.kind === 'point' ? `Point ${pk.i + 1} moved.` : pk.kind === 'handle' ? `Point ${pk.i + 1}'s curve changed.` : `Segment ${pk.i + 1} bent.`,
      this.axis ? nextHalf ?? undefined : undefined);
  }

  private cancel(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    this.drag = null;
    this.invalid = false;
    this.path = d.start;
    this.half = d.startHalf;
    this.draw();
  }

  private double(e: MouseEvent): void {
    if (!this.path) return;
    const hit = this.pick(this.toPart(e));
    if (hit?.kind === 'point') {
      this.selected = hit;
      this.toggleSelected();
    } else if (hit?.kind === 'line') {
      const c = segment(this.path, hit.i);
      this.insertAt(hit.i, nearestOnCubic(c, this.toPart(e)).t);
    }
  }

  // ---- drawing
  draw(): void {
    const { canvas, ctx } = this;
    const r = canvas.parentElement!.getBoundingClientRect();
    const dpr = devicePixelRatio;
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const kit = this.kit, path = this.path;
    if (!kit || !path) {
      canvas.dataset.points = '[]';
      return;
    }
    // fit the trace and the pocket to the pane, leaving room for the bar
    const pts: Ring = [...kit.part.traced, ...kit.part.pocket, ...path.anchors.map((a) => a.p)];
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = 36 * dpr, bottom = 112 * dpr, top = 96 * dpr;
    if (!this.drag) {
      const s = Math.max(1e-6, Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - top - bottom) / (y1 - y0 || 1)));
      this.xf = { s, ox: (W - (x1 - x0) * s) / 2 - x0 * s, oy: top + (H - top - bottom - (y1 - y0) * s) / 2 - y0 * s, dpr };
    }
    const { s, ox, oy } = this.xf;
    const cs = getComputedStyle(document.documentElement);
    const cTool = cs.getPropertyValue('--trace-tool').trim() || '#0a84ff';
    const cPocket = cs.getPropertyValue('--trace-pocket').trim() || '#ff3b30';
    const line = (P: Ring, close = true) => {
      ctx.beginPath();
      P.forEach(([x, y], k) => (k ? ctx.lineTo(ox + x * s, oy + y * s) : ctx.moveTo(ox + x * s, oy + y * s)));
      if (close) ctx.closePath();
    };
    // the photo, mapped from sheet mm into the part frame
    const img = this.image;
    if (img.complete && img.naturalWidth) {
      const [[a, b, c], [d, e, f]] = kit.part.measure.up2sheet;
      const det = a * e - b * d;
      // part = M^-1 (sheet - t); sheet = box origin + image px * (box size / image size)
      const [bx0, by0, bx1, by1] = kit.sheetBox;
      const kx = (bx1 - bx0) / img.naturalWidth, ky = (by1 - by0) / img.naturalHeight;
      const ia = e / det, ib = -b / det, id = -d / det, ie = a / det;
      const tx = -(ia * c + ib * f), ty = -(id * c + ie * f);
      ctx.save();
      ctx.globalAlpha = 0.5;
      // screen = s * (Minv * (k * px + box0) + t') + o
      ctx.setTransform(s * ia * kx, s * id * kx, s * ib * ky, s * ie * ky,
        ox + s * (ia * bx0 + ib * by0 + tx), oy + s * (id * bx0 + ie * by0 + ty));
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // the pocket (as last built) and the trace
    line(kit.part.pocket);
    ctx.fillStyle = 'rgba(255,59,48,.08)';
    ctx.fill();
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = cPocket;
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    line(kit.part.traced);
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = 'rgba(29,29,31,.55)';
    ctx.stroke();
    ctx.setLineDash([]);
    // the mirror axis, across the part, in symmetric editing
    if (this.axis) {
      const a = this.axis;
      const dir: Vec2 = [-Math.sin((a.deg * Math.PI) / 180), Math.cos((a.deg * Math.PI) / 180)];
      const o: Vec2 = [a.centre[0] + Math.cos((a.deg * Math.PI) / 180) * a.offset, a.centre[1] + Math.sin((a.deg * Math.PI) / 180) * a.offset];
      const reach = Math.hypot(x1 - x0, y1 - y0);
      line([[o[0] - dir[0] * reach, o[1] - dir[1] * reach], [o[0] + dir[0] * reach, o[1] + dir[1] * reach]], false);
      ctx.setLineDash([7 * dpr, 4 * dpr]);
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = cs.getPropertyValue('--trace-axis').trim() || '#34c759';
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // the path, with the selected segment heavier
    line(flatten(path, 0.05 / Math.max(1e-6, s / dpr / 4)).points);
    ctx.lineWidth = 4 * dpr;
    ctx.strokeStyle = 'rgba(255,255,255,.8)';
    ctx.stroke();
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = this.invalid ? cPocket : cTool;
    ctx.stroke();
    const sel = this.selected;
    if (sel?.kind === 'line') {
      const c = segment(path, sel.i);
      line([...flattenCubic(c, 0.05), c[3]], false);
      ctx.lineWidth = 4 * dpr;
      ctx.strokeStyle = this.invalid ? cPocket : cTool;
      ctx.stroke();
    }
    // the selected point's handles
    const i = this.pointIndex();
    if (i !== null && path.anchors[i]) {
      const a = path.anchors[i]!;
      for (const h of [a.hin, a.hout]) {
        if (Math.hypot(h[0], h[1]) < 1e-9) continue;
        const [px, py] = this.toScreen(a.p), [hx, hy] = this.toScreen([a.p[0] + h[0], a.p[1] + h[1]]);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(hx, hy);
        ctx.lineWidth = 1 * dpr;
        ctx.strokeStyle = cTool;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(hx, hy, 3.5 * dpr, 0, 2 * Math.PI);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.stroke();
      }
    }
    // the points: squares are corners, circles smooth; the selected one filled
    path.anchors.forEach((a, k) => {
      const [x, y] = this.toScreen(a.p);
      const r0 = 4 * dpr;
      ctx.beginPath();
      if (a.kind === 'corner') ctx.rect(x - r0, y - r0, 2 * r0, 2 * r0);
      else ctx.arc(x, y, r0, 0, 2 * Math.PI);
      ctx.fillStyle = k === i ? cTool : '#fff';
      ctx.fill();
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = cTool;
      ctx.stroke();
    });
    canvas.parentElement!.classList.add('ready');
    canvas.dataset.scale = String(s / dpr);
    // the points on screen (css px), for tests: written once the transform is known
    canvas.dataset.points = JSON.stringify(path.anchors.map((a) => this.toScreen(a.p).map((v) => +(v / dpr).toFixed(1))));
    canvas.dataset.origin = JSON.stringify([ox / dpr, oy / dpr]);
    canvas.dataset.mirrored = String(!!this.axis);
  }
}
