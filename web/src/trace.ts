// The Trace pane: the perspective-corrected calibration sheet with every part's tool (blue) and
// pocket (red) outlines drawn where the part lies on the paper, all in sheet mm, plus each mirror
// axis (green, dashed) where "Symmetric tool" is on, and, for a single part, the pocket's width and
// length as dimension lines, measured along the part's own axes.
import type { Measurements, OutlineResult } from './worker/protocol';

export const isDark = () => document.documentElement.dataset.theme === 'dark';

function rgba(col: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(col);
  if (!m) return col;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

type Pt = [number, number];

/** Text angle for a direction, kept upright (between -90 and 90 degrees). */
function upright(dx: number, dy: number): number {
  let a = Math.atan2(dy, dx);
  if (a > Math.PI / 2 + 1e-6) a -= Math.PI;
  else if (a <= -Math.PI / 2 + 1e-6) a += Math.PI;
  return a;
}

const fmt = (v: number) => v.toFixed(1);

/** Dimension lines for the pocket's width and length. `toScreen` maps the
 * upright outline frame (mm) to canvas pixels. */
/** Label font size (canvas px; follows the pane, within 9 to 12 css px) and how far outside the pocket's box
 * the dimension lines sit. */
function measureLayout(W: number, H: number, dpr: number): { fs: number; dimOff: number; margin: number } {
  const fs = Math.max(9, Math.min(12, Math.min(W, H) / dpr / 45)) * dpr;
  const dimOff = 2.6 * fs;
  return { fs, dimOff, margin: dimOff + 1.2 * fs };
}

/** The corners of the pocket's box (upright frame) in sheet mm. */
function boxOnSheet(m: Measurements): Pt[] {
  const [[a, b, c], [d, e, f]] = m.up2sheet;
  const k = m.pocket;
  return ([[k.xmin, k.ymin], [k.xmax, k.ymin], [k.xmax, k.ymax], [k.xmin, k.ymax]] as Pt[])
    .map(([x, y]) => [a * x + b * y + c, d * x + e * y + f]);
}

function drawMeasure(ctx: CanvasRenderingContext2D, m: Measurements, toScreen: (q: Pt) => Pt,
  W: number, H: number, dpr: number): void {
  const k = m.pocket;
  const { fs, dimOff } = measureLayout(W, H, dpr);
  const ink = 'rgba(29,29,31,.82)';
  const halo = 'rgba(255,255,255,.8)';
  const o = toScreen([0, 0]);
  /** Screen direction (unit) of an upright-frame direction. */
  const dir = (v: Pt): Pt => {
    const [x, y] = toScreen(v);
    const l = Math.hypot(x - o[0], y - o[1]) || 1;
    return [(x - o[0]) / l, (y - o[1]) / l];
  };
  const add = (p: Pt, d: Pt, f: number): Pt => [p[0] + d[0] * f, p[1] + d[1] * f];
  /** The four sides of the pocket box: ends and outward normal on screen. */
  const sides = [
    { a: [k.xmin, k.ymin], b: [k.xmax, k.ymin], n: dir([0, -1]), along: 'x' },
    { a: [k.xmin, k.ymax], b: [k.xmax, k.ymax], n: dir([0, 1]), along: 'x' },
    { a: [k.xmin, k.ymin], b: [k.xmin, k.ymax], n: dir([-1, 0]), along: 'y' },
    { a: [k.xmax, k.ymin], b: [k.xmax, k.ymax], n: dir([1, 0]), along: 'y' },
  ].map((sd) => ({ ...sd, A: toScreen(sd.a as Pt), B: toScreen(sd.b as Pt) }));
  ctx.save();
  ctx.font = `600 ${fs}px -apple-system, BlinkMacSystemFont, system-ui, "Helvetica Neue", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  /** How far a point is inside the canvas (negative when outside). */
  const inside = ([x, y]: Pt) => Math.min(x, y, W - x, H - y);
  // one dimension line per axis, on whichever of its two sides has more room on the canvas; on a tie
  // prefer the side facing up (width) or right (length)
  for (const along of ['x', 'y'] as const) {
    const [s1, s2] = sides.filter((sd) => sd.along === along) as [typeof sides[0], typeof sides[0]];
    const room = (sd: typeof s1) => Math.min(inside(add(sd.A, sd.n, dimOff + fs)), inside(add(sd.B, sd.n, dimOff + fs)));
    const pref = (sd: typeof s1) => (along === 'x' ? -sd.n[1] : sd.n[0]);
    const r1 = room(s1), r2 = room(s2);
    const sd = Math.min(r1, r2) > fs ? (pref(s1) >= pref(s2) ? s1 : s2) : r1 >= r2 ? s1 : s2;
    const P = add(sd.A, sd.n, dimOff), Q = add(sd.B, sd.n, dimOff);
    const len = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
    if (len < 1) continue;
    const u: Pt = [(Q[0] - P[0]) / len, (Q[1] - P[1]) / len];
    const line = (path: () => void, width: number) => {
      ctx.beginPath();
      path();
      ctx.lineWidth = width + 2.5 * dpr;
      ctx.strokeStyle = halo;
      ctx.stroke();
      ctx.lineWidth = width;
      ctx.strokeStyle = ink;
      ctx.stroke();
    };
    // extension lines from the box corners, then the dimension line with arrowheads
    line(() => {
      for (const c of [sd.A, sd.B]) {
        const e0 = add(c, sd.n, 0.25 * fs), e1 = add(c, sd.n, dimOff + 0.35 * fs);
        ctx.moveTo(e0[0], e0[1]);
        ctx.lineTo(e1[0], e1[1]);
      }
    }, 0.8 * dpr);
    line(() => {
      ctx.moveTo(P[0], P[1]);
      ctx.lineTo(Q[0], Q[1]);
    }, 1 * dpr);
    const ah = Math.min(0.55 * fs, len / 3);
    for (const [tip, d] of [[P, u], [Q, [-u[0], -u[1]] as Pt]] as const) {
      ctx.beginPath();
      ctx.moveTo(tip[0], tip[1]);
      const base = add(tip, d, ah);
      ctx.lineTo(...add(base, [-d[1], d[0]], ah * 0.38));
      ctx.lineTo(...add(base, [d[1], -d[0]], ah * 0.38));
      ctx.closePath();
      ctx.fillStyle = ink;
      ctx.fill();
    }
    // the size on a paper-coloured pill, centred on the line and along it
    const size = along === 'x' ? m.pocketSize[0] : m.pocketSize[1];
    const text = `${fmt(size)} mm`;
    const tw = ctx.measureText(text).width;
    const mid = add(P, u, len / 2);
    ctx.save();
    ctx.translate(mid[0], mid[1]);
    ctx.rotate(upright(u[0], u[1]));
    ctx.beginPath();
    ctx.roundRect(-tw / 2 - 0.45 * fs, -0.72 * fs, tw + 0.9 * fs, 1.44 * fs, 0.72 * fs);
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.fill();
    ctx.lineWidth = 0.8 * dpr;
    ctx.strokeStyle = 'rgba(29,29,31,.25)';
    ctx.stroke();
    ctx.fillStyle = '#1d1d1f';
    ctx.fillText(text, 0, 0.05 * fs);
    ctx.restore();
  }
  ctx.restore();
}

export class TraceView {
  private readonly ctx: CanvasRenderingContext2D;
  private image = new Image();
  private imageUrl = '';
  private outline: OutlineResult | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** Show a new outline; loads its sheet image if it changed. */
  show(outline: OutlineResult): void {
    this.outline = outline;
    if (outline.sheetImage !== this.imageUrl) {
      this.imageUrl = outline.sheetImage;
      const img = new Image();
      img.onload = () => {
        if (this.image === img) this.draw();
      };
      img.src = outline.sheetImage;
      this.image = img;
    }
    this.draw();
  }

  draw(): void {
    const { canvas: flat, ctx } = this;
    const r = flat.parentElement!.getBoundingClientRect();
    const dpr = devicePixelRatio;
    flat.width = r.width * dpr;
    flat.height = r.height * dpr;
    const W = flat.width;
    const H = flat.height;
    const cs = getComputedStyle(document.documentElement);
    const cTool = cs.getPropertyValue('--trace-tool').trim();
    const cPocket = cs.getPropertyValue('--trace-pocket').trim();
    const cAxis = cs.getPropertyValue('--trace-axis').trim();
    ctx.clearRect(0, 0, W, H);
    const o = this.outline;
    if (!o) return;
    const { parts } = o;
    // dimensions only for a single part; with several the lines would cross each other
    const measure = parts.length === 1 ? parts[0]!.measure : undefined;
    // the whole calibration sheet, fitted to the pane
    const [bx0, by0, bx1, by1] = o.sheetBox;
    const bw = bx1 - bx0;
    const bh = by1 - by0;
    const pad = 28 * dpr;
    let s = Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh);
    let ox = (W - bw * s) / 2;
    let oy = (H - bh * s) / 2;
    if (measure) {
      // zoom out if the dimension lines around the pocket's box would run off the pane (a diagonal tool near
      // the paper's edge): fit the sheet and the box plus the dimension margin
      const { margin } = measureLayout(W, H, dpr);
      const pts = boxOnSheet(measure);
      const x0 = Math.min(bx0, ...pts.map((q) => q[0])), x1 = Math.max(bx1, ...pts.map((q) => q[0]));
      const y0 = Math.min(by0, ...pts.map((q) => q[1])), y1 = Math.max(by1, ...pts.map((q) => q[1]));
      const px0 = Math.min(...pts.map((q) => q[0])), px1 = Math.max(...pts.map((q) => q[0]));
      const py0 = Math.min(...pts.map((q) => q[1])), py1 = Math.max(...pts.map((q) => q[1]));
      const fits = () => ox + (px0 - bx0) * s >= margin && ox + (px1 - bx0) * s <= W - margin
        && oy + (py0 - by0) * s >= margin && oy + (py1 - by0) * s <= H - margin;
      if (!fits()) {
        const m = Math.max(pad, margin);
        s = Math.max(1e-6, Math.min((W - 2 * m) / (x1 - x0), (H - 2 * m) / (y1 - y0), s));
        ox = (W - (x1 - x0) * s) / 2 + (bx0 - x0) * s;
        oy = (H - (y1 - y0) * s) / 2 + (by0 - y0) * s;
      }
    }
    const img = this.image;
    if (img.complete && img.naturalWidth) {
      ctx.save();
      ctx.shadowColor = isDark() ? 'rgba(0,0,0,.55)' : 'rgba(0,0,0,.18)';
      ctx.shadowBlur = 18 * dpr;
      ctx.shadowOffsetY = 4 * dpr;
      ctx.beginPath();
      ctx.roundRect(ox, oy, bw * s, bh * s, 8 * dpr);
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(ox, oy, bw * s, bh * s, 8 * dpr);
      ctx.clip();
      ctx.drawImage(img, ox, oy, bw * s, bh * s);
      ctx.restore();
    }
    const path = (pts: [number, number][]) => {
      ctx.beginPath();
      pts.forEach(([px, py], i) => {
        const x = ox + (px - bx0) * s;
        const y = oy + (py - by0) * s;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
    };
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const halo = 'rgba(255,255,255,.7)'; // the paper is light in both themes
    for (const q of parts) {
      path(q.sheetPocket);
      ctx.lineWidth = 4 * dpr;
      ctx.strokeStyle = halo;
      ctx.stroke();
      ctx.fillStyle = rgba(cPocket, 0.14);
      ctx.fill();
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = cPocket;
      ctx.stroke();
    }
    for (const q of parts) {
      path(q.sheetTool);
      ctx.lineWidth = 3.5 * dpr;
      ctx.strokeStyle = halo;
      ctx.stroke();
      ctx.lineWidth = 1.6 * dpr;
      ctx.strokeStyle = cTool;
      ctx.stroke();
    }
    const axes = parts.flatMap((q) => (q.sheetAxis ? [q.sheetAxis] : []));
    flat.parentElement!.classList.toggle('has-axis', axes.length > 0);
    for (const [[ax, ay], [bx, by]] of axes) {
      ctx.beginPath();
      ctx.moveTo(ox + (ax - bx0) * s, oy + (ay - by0) * s);
      ctx.lineTo(ox + (bx - bx0) * s, oy + (by - by0) * s);
      ctx.setLineDash([]);
      ctx.lineWidth = 4 * dpr;
      ctx.strokeStyle = halo;
      ctx.stroke();
      ctx.setLineDash([7 * dpr, 4 * dpr]);
      ctx.lineWidth = 1.8 * dpr;
      ctx.strokeStyle = cAxis;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (measure) {
      const [[a, b, c], [d, e, f]] = measure.up2sheet;
      drawMeasure(ctx, measure, ([x, y]) => [ox + (a * x + b * y + c - bx0) * s, oy + (d * x + e * y + f - by0) * s],
        W, H, dpr);
    }
    flat.parentElement!.classList.toggle('has-measure', !!measure);
    flat.parentElement!.classList.add('ready');
  }
}
