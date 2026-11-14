// Straight edges for traced outlines. The segmentation mask wobbles along edges that are really straight (a
// box's sides, a ruler's edge): runs of the outline that fit a line closely, and whose deviation is noise
// rather than a curve, are replaced by that line. The line is moved out to the run's outermost point, so the
// straightened outline holds the traced one and a pocket never gets tighter. Lines within a degree or two of
// the outline's own axes (it is upright, so x and y) are made exactly parallel to them.
import { signedArea, type Ring, type Vec2 } from '../geometry/pocket';

export interface StraightenOptions {
  /** Largest deviation (mm) a straight run may have from its line. */
  tolerance: number;
  /** Shortest run (mm) that counts as a straight edge. */
  minLength: number;
  /** Below this deviation (mm) a run is straight however its points scatter. */
  flat: number;
  /** A run may also bow this gently: by up to length² / (8 * minRadius) mm, i.e. as an arc of this radius (mm).
   * Real curves are much tighter; this catches a straight edge the mask bends slightly (a glare on metal). */
  minRadius: number;
  /** How many times the points of a noisy straight run cross its line at least; a curve crosses about twice. */
  crossings: number;
  /** Lines within this many degrees of the x or y axis are made exactly parallel to it. */
  snapDeg: number;
  /** Length (mm) at each end of a run blended back into the outline, so corners keep their shape. */
  blend: number;
}

/** Points a run tries to grow by at a time (then fewer, near where it stops). */
const GROW = 8;

export const STRAIGHTEN: StraightenOptions = {
  tolerance: 0.8, minLength: 15, flat: 0.1, minRadius: 500, crossings: 4, snapDeg: 1.5, blend: 1.5,
};

interface Line {
  /** A point on the line and its unit direction. */
  c: Vec2;
  d: Vec2;
  /** Whether it was made parallel to the x or y axis. */
  snapped?: boolean;
}

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Total-least-squares line through `pts`. */
function fitLine(pts: readonly Vec2[]): Line {
  const n = pts.length;
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= n; cy /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) {
    const dx = x - cx, dy = y - cy;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const t = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { c: [cx, cy], d: [Math.cos(t), Math.sin(t)] };
}

/** The points of the closed ring `P` from index `i` to `j` (inclusive, wrapping). */
function run(P: readonly Vec2[], i: number, j: number): Vec2[] {
  const n = P.length;
  const out: Vec2[] = [];
  for (let k = i; ; k = (k + 1) % n) {
    out.push(P[k]!);
    if (k === j) return out;
  }
}

/** `L` moved to the mean of `pts` along its normal, if `pts` is a straight edge with noise about it. */
function fits(pts: readonly Vec2[], L: Line, o: StraightenOptions): Line | null {
  const nrm: Vec2 = [-L.d[1], L.d[0]];
  const r = pts.map((p) => dot(sub(p, L.c), nrm));
  const mean = r.reduce((s, v) => s + v, 0) / r.length;
  const dev = r.map((v) => v - mean);
  const worst = Math.max(...dev.map(Math.abs));
  if (worst > o.tolerance) return null;
  // straight if it barely deviates, bows less than a minRadius arc would, or only scatters about the line
  const len = dist(pts[0]!, pts[pts.length - 1]!);
  if (worst > Math.max(o.flat, (len * len) / (8 * o.minRadius))) {
    let cross = 0;
    for (let k = 1; k < dev.length; k++) if (dev[k - 1]! * dev[k]! < 0) cross++;
    if (cross < o.crossings) return null;
  }
  return { c: [L.c[0] + nrm[0] * mean, L.c[1] + nrm[1] * mean], d: L.d };
}

/** The line of `pts` if it is a straight edge with noise: parallel to the x or y axis when within snapDeg of
 * it and that still fits, else at its own angle. */
function straightLine(pts: readonly Vec2[], o: StraightenOptions): Line | null {
  if (pts.length < 3 || dist(pts[0]!, pts[pts.length - 1]!) < o.minLength) return null;
  const L = fitLine(pts);
  const deg = (Math.atan2(L.d[1], L.d[0]) * 180) / Math.PI;
  const off = ((deg % 90) + 90) % 90;
  if (Math.min(off, 90 - off) <= o.snapDeg) {
    const a = (Math.round(deg / 90) * Math.PI) / 2;
    const snapped = fits(pts, { c: L.c, d: [Math.round(Math.cos(a)), Math.round(Math.sin(a))] }, o);
    if (snapped) return { ...snapped, snapped: true };
  }
  return fits(pts, L, o);
}

/** Indices of the closed ring's Ramer-Douglas-Peucker vertices at `eps`, in order. */
function rdpClosed(P: readonly Vec2[], eps: number): number[] {
  const n = P.length;
  // split the ring at its two farthest-apart points (from the first point, then from that one)
  let a = 0;
  for (let k = 1; k < n; k++) if (dist(P[k]!, P[0]!) > dist(P[a]!, P[0]!)) a = k;
  let b = a;
  for (let k = 0; k < n; k++) if (dist(P[k]!, P[a]!) > dist(P[b]!, P[a]!)) b = k;
  const keep = new Set([a, b]);
  const rec = (i: number, j: number) => {
    const pts = run(P, i, j);
    if (pts.length < 3) return;
    const A = pts[0]!, B = pts[pts.length - 1]!;
    const len = dist(A, B) || 1;
    let best = -1, bestD = eps;
    pts.forEach((p, k) => {
      if (k === 0 || k === pts.length - 1) return;
      const d = Math.abs((B[0] - A[0]) * (A[1] - p[1]) - (A[0] - p[0]) * (B[1] - A[1])) / len;
      if (d > bestD) { bestD = d; best = k; }
    });
    if (best < 0) return;
    const m = (i + best) % n;
    keep.add(m);
    rec(i, m);
    rec(m, j);
  };
  rec(a, b);
  rec(b, a);
  return [...keep].sort((x, y) => x - y);
}

/** `P` (a closed outline, mm, its last point repeating the first) with its straight runs made straight. */
export function straighten(P: Ring, o: StraightenOptions = STRAIGHTEN): Ring {
  const closed = P.length > 1 && P[0]![0] === P[P.length - 1]![0] && P[0]![1] === P[P.length - 1]![1];
  const Q = closed ? P.slice(0, -1) : [...P];
  const n = Q.length;
  if (n < 8) return P;
  const ccw = signedArea(Q) > 0;
  const V = rdpClosed(Q, o.tolerance);
  // seed a run at each RDP span that is straight, then grow it point by point both ways while it stays one
  // line (so a side whose end bows, or whose span also holds a bit of corner, still becomes one line)
  const runs: { i: number; j: number; line: Line }[] = [];
  const covered = new Uint8Array(n);
  /** Whether no point from index a to b (wrapping) is in a run yet. */
  const free = (a: number, b: number) => {
    for (let k = a; ; k = (k + 1) % n) {
      if (covered[k]) return false;
      if (k === b) return true;
    }
  };
  const len = (a: number, b: number) => ((b - a + n) % n) + 1;
  for (let s = 0; s < V.length; s++) {
    let i = V[s]!, j = V[(s + 1) % V.length]!;
    if (!free(i, j)) continue;
    let line = straightLine(run(Q, i, j), o);
    if (!line) continue;
    for (let grew = true; grew;) {
      grew = false;
      for (const end of ['i', 'j'] as const) {
        for (let step = GROW; step >= 1; step = Math.floor(step / 2)) {
          const a = end === 'i' ? (i - step + n) % n : i;
          const b = end === 'j' ? (j + step) % n : j;
          if (len(a, b) >= n - 2 || !free(a, b)) continue;
          const longer = straightLine(run(Q, a, b), o);
          // a side squared to the axes stays squared: it doesn't grow into a run that would tilt it
          if (!longer || (line.snapped && !longer.snapped)) continue;
          [i, j, line, grew] = [a, b, longer, true];
          break;
        }
      }
    }
    for (let k = i; ; k = (k + 1) % n) {
      covered[k] = 1;
      if (k === j) break;
    }
    runs.push({ i, j, line });
  }
  if (!runs.length) return P;
  const out = Q.map((p): Vec2 => [p[0], p[1]]);
  for (const { i, j, line } of runs) {
    const pts = run(Q, i, j);
    // outward normal: the outline's interior is on the left of a counter-clockwise run
    let nrm: Vec2 = [line.d[1], -line.d[0]];
    const along = sub(pts[pts.length - 1]!, pts[0]!);
    if (dot(along, line.d) < 0) nrm = [-nrm[0], -nrm[1]];
    if (!ccw) nrm = [-nrm[0], -nrm[1]];
    const shift = Math.max(...pts.map((p) => dot(sub(p, line.c), nrm)));
    // arc length from each end, for the blend
    const s: number[] = [0];
    for (let k = 1; k < pts.length; k++) s.push(s[k - 1]! + dist(pts[k]!, pts[k - 1]!));
    const total = s[s.length - 1]!;
    pts.forEach((p, k) => {
      const t = Math.min(1, Math.min(s[k]!, total - s[k]!) / Math.max(1e-9, o.blend));
      const h = dot(sub(p, line.c), nrm) - shift; // <= 0: inside the line
      const q: Vec2 = [p[0] - nrm[0] * h, p[1] - nrm[1] * h];
      // in the blend zone move only outward, so the outline still holds the traced one
      const w = h < 0 ? t : 1;
      out[(i + k) % n] = [p[0] + (q[0] - p[0]) * w, p[1] + (q[1] - p[1]) * w];
    });
  }
  return closed ? [...out, out[0]!] : out;
}
