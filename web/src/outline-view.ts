// The Outline pane: one part's outline as an editable path, over the photo it was traced from. Points sit on
// the outline (squares are corners, circles smooth); the selected point shows its handles. Drag a point, a
// handle or the outline itself; double-click a point to switch it between corner and smooth, or the outline to
// add a point. The traced outline stays drawn faintly and is what the Detail slider and deleting a point refit
// to. An edit that would make the outline cross itself is drawn red and undone when let go.
import type { Ring, Vec2 } from './geometry/pocket';
import type { Placement } from './kit';
import { flatten, flattenCubic, insertAnchor, nearest, nearestOnCubic, segment, straightenSegment, type BezierPath } from './path/bezier';
import { bendSegment, deleteAnchor, isValid, moveAnchor, moveHandle, refit, roundCorner, toggleKind } from './path/edit';
import { FIT } from './path/fit';
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
  /** A committed edit: the part's new outline, or undefined to go back to the traced one. */
  change(path: BezierPath | undefined, said: string): void;
  undo(redo: boolean): void;
}

type Pick = { kind: 'point'; i: number } | { kind: 'handle'; i: number; side: 'in' | 'out' } | { kind: 'line'; i: number; t: number };

interface Drag {
  pointer: number;
  pick: Pick;
  start: BezierPath;
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
    if (!this.drag) this.path = kit ? (kit.placement.path ?? this.fitted(key)) : null;
    this.sync();
    this.draw();
  }

  /** The outline fitted to the trace at the slider's tolerance (cached per part and tolerance). */
  private fittedPath: BezierPath | null = null;
  private fitted(key: string): BezierPath {
    const k = `${key}@${this.tolerance}`;
    if (k !== this.fittedFor || !this.fittedPath) {
      this.fittedPath = refit(this.kit!.part.traced, this.tolerance);
      this.fittedFor = k;
    }
    return this.fittedPath;
  }

  private say(text: string): void {
    this.ui.status.textContent = text;
  }

  /** Commit `next` as the part's outline. */
  private commit(next: BezierPath, said: string): void {
    if (!isValid(next)) {
      this.say('That would make the outline cross itself, so it was left as it was.');
      this.draw();
      return;
    }
    this.path = next;
    this.hooks.change(next, said);
    this.say(said);
    this.sync();
    this.draw();
  }

  // ---- the bar: detail slider, point count and buttons
  private detail(commit: boolean): void {
    if (!this.kit) return;
    this.tolerance = +this.ui.detail.value;
    this.ui.detailValue.textContent = `${this.tolerance.toFixed(2)} mm`;
    const next = refit(this.kit.part.traced, this.tolerance);
    this.selected = null;
    if (commit) this.commit(next, `Refitted within ${this.tolerance.toFixed(2)} mm of the trace: ${next.anchors.length} points.`);
    else {
      this.path = next;
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
    this.canvas.dataset.points = p ? JSON.stringify(p.anchors.map((a) => this.toScreen(a.p).map((v) => +(v / this.xf.dpr).toFixed(1)))) : '[]';
  }

  // ---- edits on the selection (buttons and keys)
  private pointIndex(): number | null {
    return this.selected && this.selected.kind !== 'line' ? this.selected.i : null;
  }

  private toggleSelected(): void {
    const i = this.pointIndex();
    if (i === null || !this.path) return;
    const next = toggleKind(this.path, i);
    this.commit(next, `Point ${i + 1} is now ${next.anchors[i]!.kind}.`);
  }

  /** Straighten the selected segment, or the one after the selected point. */
  private straightenSelected(): void {
    if (!this.selected || !this.path) return;
    const i = this.selected.i;
    this.commit(straightenSegment(this.path, i), `Segment ${i + 1} is straight.`);
  }

  private roundSelected(): void {
    const i = this.pointIndex();
    if (i === null || !this.path || this.path.anchors[i]!.kind !== 'corner') return;
    const r = Math.min(20, Math.max(0.5, +this.ui.radius.value || 2));
    const { path: next, radius } = roundCorner(this.path, i, r);
    if (!radius) {
      this.say(`Point ${i + 1} barely turns, so there is no corner to round.`);
      return;
    }
    this.selected = null;
    const used = +radius.toFixed(2);
    this.commit(next, used < r - 0.005 ? `Point ${i + 1} rounded to ${used} mm, as much as its sides allow.` : `Point ${i + 1} rounded to ${r} mm.`);
  }

  /** A point added on the selected segment where it was picked, or halfway along the one after the selected
   * point; the shape doesn't change. */
  private addPoint(): void {
    const sel = this.selected;
    if (!sel || !this.path) {
      this.say('Pick a point or a stretch of the outline first, or double-click the outline where a point should go.');
      return;
    }
    const { path, index } = insertAnchor(this.path, sel.i, sel.kind === 'line' ? sel.t : 0.5);
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
      this.commit(moveAnchor(p, i, [a[0] + dx!, a[1] + dy!], false), `Point ${i + 1} moved.`);
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
    this.drag = { pointer: e.pointerId, pick: hit, start: this.path, from: at, moved: false };
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
    this.path = pk.kind === 'point' ? moveAnchor(s, pk.i, [s.anchors[pk.i]!.p[0] + at[0] - d.from[0], s.anchors[pk.i]!.p[1] + at[1] - d.from[1]], !e.altKey)
      : pk.kind === 'handle' ? moveHandle(s, pk.i, pk.side, at, e.altKey)
        : bendSegment(s, pk.i, pk.t, at);
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
    const bad = this.invalid;
    this.invalid = false;
    if (!d.moved) {
      this.draw();
      return;
    }
    this.path = d.start;
    if (bad) {
      this.say('The outline would have crossed itself, so it was put back.');
      this.draw();
      return;
    }
    const pk = d.pick;
    this.commit(next, pk.kind === 'point' ? `Point ${pk.i + 1} moved.` : pk.kind === 'handle' ? `Point ${pk.i + 1}'s curve changed.` : `Segment ${pk.i + 1} bent.`);
  }

  private cancel(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    this.drag = null;
    this.invalid = false;
    this.path = d.start;
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
      const t = nearestOnCubic(c, this.toPart(e)).t;
      const { path, index } = insertAnchor(this.path, hit.i, t);
      this.selected = { kind: 'point', i: index };
      this.commit(path, `Point added: ${path.anchors.length} points.`);
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
    if (!kit || !path) return;
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
    canvas.dataset.origin = JSON.stringify([ox / dpr, oy / dpr]);
  }
}
