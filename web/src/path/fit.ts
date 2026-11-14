// Fitting a traced outline (a dense closed polyline, mm) with a few-anchor cubic Bézier path to edit.
//
// The span fitter is a TypeScript port of paper.js's PathFitter (src/path/PathFitter.js, MIT License,
// Copyright (c) 2011-2020 Jürg Lehni & Jonathan Puckey, http://paperjs.org), itself Philip J. Schneider's
// "An Algorithm for Automatically Fitting Digitized Curves" (Graphics Gems, 1990) with Lehni's changes:
// least-squares handle lengths along fixed end tangents, Newton-Raphson reparameterisation, and a split at
// the worst point (with a central-difference tangent, so the joins are smooth) when the fit is still off.
// Its error is a squared distance.
//
// Around it: corners (a sharp turn over a few mm) and straight runs (left exactly straight by
// vision/straighten.ts) split the outline into spans; straight runs become straight segments and every other
// span is fitted between its ends. A span whose fit cuts into the traced outline by more than the inward
// limit is refitted tighter, so a pocket made from the path never gets smaller than the tool.
import { signedArea, type Ring, type Vec2 } from '../geometry/pocket';
import {
  add, derivative, dist, dot, evaluate, len, nearestOnCubic, scale, sub, type Anchor, type BezierPath, type Cubic,
} from './bezier';

export interface FitOptions {
  /** Largest distance (mm) of the traced points from the fitted path. */
  tolerance: number;
  /** Largest distance (mm) the path may run inside the traced outline. */
  inward: number;
  /** A turn of at least this many degrees across `cornerWindow` mm either side of a point is a corner. */
  cornerDeg: number;
  cornerWindow: number;
  /** Shortest exactly straight run (mm) kept as a straight segment. */
  minStraight: number;
}

export const FIT: FitOptions = { tolerance: 0.3, inward: 0.15, cornerDeg: 35, cornerWindow: 2.5, minStraight: 5 };

const unit = (v: Vec2): Vec2 => {
  const l = len(v);
  return l < 1e-12 ? [0, 0] : [v[0] / l, v[1] / l];
};
const withLength = (v: Vec2, l: number): Vec2 => scale(unit(v), l);

// ---- Schneider / paper.js PathFitter, on one open run of points

/** Bézier segments through `points` (first to last), leaving the first along `t1` and arriving at the last
 * from `t2` (both pointing into the run), each point within sqrt(`errorSq`) of them where possible. */
export function fitCubics(points: readonly Vec2[], errorSq: number, t1: Vec2, t2: Vec2): Cubic[] {
  const out: Cubic[] = [];
  if (points.length < 2) return out;
  fitCubic(points, out, errorSq, 0, points.length - 1, t1, t2);
  return out;
}

function fitCubic(P: readonly Vec2[], out: Cubic[], error: number, first: number, last: number, t1: Vec2, t2: Vec2): void {
  if (last - first === 1) {
    const d = dist(P[first]!, P[last]!) / 3;
    out.push([P[first]!, add(P[first]!, withLength(t1, d)), add(P[last]!, withLength(t2, d)), P[last]!]);
    return;
  }
  const u = chordLengthParameterize(P, first, last);
  let maxError = Math.max(error, error * error);
  let split = Math.floor((first + last) / 2);
  let inOrder = true;
  for (let i = 0; i <= 4; i++) {
    const curve = generateBezier(P, first, last, u, t1, t2);
    const max = findMaxError(P, first, last, curve, u);
    if (max.error < error && inOrder) {
      out.push(curve);
      return;
    }
    split = max.index;
    if (max.error >= maxError) break;
    inOrder = reparameterize(P, first, last, u, curve);
    maxError = max.error;
  }
  // splitting at an end would not make progress
  split = Math.min(last - 1, Math.max(first + 1, split));
  const tc = sub(P[split - 1]!, P[split + 1]!);
  fitCubic(P, out, error, first, split, t1, tc);
  fitCubic(P, out, error, split, last, scale(tc, -1), t2);
}

function generateBezier(P: readonly Vec2[], first: number, last: number, u: number[], t1: Vec2, t2: Vec2): Cubic {
  const EPS = 1e-12;
  const pt1 = P[first]!, pt2 = P[last]!;
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0, l = last - first + 1; i < l; i++) {
    const s = u[i]!, t = 1 - s, b = 3 * s * t;
    const b0 = t * t * t, b1 = b * t, b2 = b * s, b3 = s * s * s;
    const a1 = withLength(t1, b1), a2 = withLength(t2, b2);
    const tmp = sub(sub(P[first + i]!, scale(pt1, b0 + b1)), scale(pt2, b2 + b3));
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let alpha1: number, alpha2: number;
  if (Math.abs(det) > EPS) {
    alpha1 = (x0 * c11 - x1 * c01) / det;
    alpha2 = (c00 * x1 - c01 * x0) / det;
  } else {
    const c0 = c00 + c01, c1 = c01 + c11;
    alpha1 = alpha2 = Math.abs(c0) > EPS ? x0 / c0 : Math.abs(c1) > EPS ? x1 / c1 : 0;
  }
  const segLength = dist(pt1, pt2);
  const eps = EPS * segLength;
  let h1: Vec2 | null = null, h2: Vec2 | null = null;
  if (alpha1 < eps || alpha2 < eps) {
    alpha1 = alpha2 = segLength / 3; // Wu/Barsky heuristic
  } else {
    // control points out of order along the chord: fall back to the heuristic too
    const line = sub(pt2, pt1);
    h1 = withLength(t1, alpha1);
    h2 = withLength(t2, alpha2);
    if (dot(h1, line) - dot(h2, line) > segLength * segLength) {
      alpha1 = alpha2 = segLength / 3;
      h1 = h2 = null;
    }
  }
  return [pt1, add(pt1, h1 ?? withLength(t1, alpha1)), add(pt2, h2 ?? withLength(t2, alpha2)), pt2];
}

function reparameterize(P: readonly Vec2[], first: number, last: number, u: number[], curve: Cubic): boolean {
  for (let i = first; i <= last; i++) u[i - first] = findRoot(curve, P[i]!, u[i - first]!);
  for (let i = 1; i < u.length; i++) if (u[i]! <= u[i - 1]!) return false;
  return true;
}

/** One Newton-Raphson step towards the parameter of the curve point closest to `p`. */
function findRoot(c: Cubic, p: Vec2, u: number): number {
  const d1: Vec2[] = [0, 1, 2].map((i) => scale(sub(c[i + 1]!, c[i]!), 3));
  const d2: Vec2[] = [0, 1].map((i) => scale(sub(d1[i + 1]!, d1[i]!), 2));
  const q = evaluate(c, u);
  const q1 = bezierN(d1, u), q2 = bezierN(d2, u);
  const diff = sub(q, p);
  const df = dot(q1, q1) + dot(diff, q2);
  return Math.abs(df) < 1e-12 ? u : u - dot(diff, q1) / df;
}

/** A Bézier of any degree at `t` (de Casteljau). */
function bezierN(c: readonly Vec2[], t: number): Vec2 {
  const tmp = c.slice();
  for (let i = 1; i < tmp.length; i++) {
    for (let j = 0; j < tmp.length - i; j++) tmp[j] = add(scale(tmp[j]!, 1 - t), scale(tmp[j + 1]!, t));
  }
  return tmp[0]!;
}

function chordLengthParameterize(P: readonly Vec2[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u[i - first] = u[i - first - 1]! + dist(P[i]!, P[i - 1]!);
  const m = last - first;
  for (let i = 1; i <= m; i++) u[i] = u[m]! > 0 ? u[i]! / u[m]! : i / m;
  return u;
}

/** The largest squared distance of the run's points from the curve, and where. */
function findMaxError(P: readonly Vec2[], first: number, last: number, c: Cubic, u: number[]): { error: number; index: number } {
  let index = Math.floor((last - first + 1) / 2);
  let max = 0;
  for (let i = first + 1; i < last; i++) {
    const v = sub(evaluate(c, u[i - first]!), P[i]!);
    const d = dot(v, v);
    if (d >= max) {
      max = d;
      index = i;
    }
  }
  return { error: max, index };
}

// ---- the outline: corners, straight runs and spans

/** The ring without a repeated closing point or consecutive duplicates. */
function openRing(P: Ring): Vec2[] {
  const out: Vec2[] = [];
  for (const p of P) if (!out.length || dist(out[out.length - 1]!, p) > 1e-9) out.push(p);
  while (out.length > 1 && dist(out[0]!, out[out.length - 1]!) <= 1e-9) out.pop();
  return out;
}

/** Index of the point `mm` along the ring from `i` (forwards, or backwards for negative `mm`). */
function walk(Q: readonly Vec2[], i: number, mm: number): number {
  const n = Q.length, step = mm < 0 ? -1 : 1;
  let k = i, s = 0;
  while (s < Math.abs(mm)) {
    const next = (k + step + n) % n;
    s += dist(Q[k]!, Q[next]!);
    k = next;
    if (k === i) break;
  }
  return k;
}

/** Turning angle (degrees, 0-180) at point i over `w` mm either side. */
function turn(Q: readonly Vec2[], i: number, w: number): number {
  const a = sub(Q[i]!, Q[walk(Q, i, -w)]!), b = sub(Q[walk(Q, i, w)]!, Q[i]!);
  const la = len(a), lb = len(b);
  if (la < 1e-9 || lb < 1e-9) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (la * lb)))) * 180) / Math.PI;
}

/** Maximal runs [i, j] of points that lie exactly on one line, at least `minLen` mm long. */
function straightRuns(Q: readonly Vec2[], minLen: number): [number, number][] {
  const n = Q.length;
  const flat = Q.map((_, i) => {
    const a = Q[(i + n - 1) % n]!, b = Q[i]!, c = Q[(i + 1) % n]!;
    const ab = sub(b, a), bc = sub(c, b);
    const l = len(ab) * len(bc);
    return l > 0 && Math.abs(ab[0] * bc[1] - ab[1] * bc[0]) / l < 1e-7 && dot(ab, bc) > 0;
  });
  if (flat.every(Boolean)) return [];
  // start at a point that isn't flat, so no run wraps past the start
  const s0 = flat.findIndex((f) => !f);
  const runs: [number, number][] = [];
  for (let k = 1; k <= n; k++) {
    const i = (s0 + k) % n;
    if (!flat[i]) continue;
    let e = i;
    while (flat[(e + 1) % n] && (e + 1) % n !== s0) e = (e + 1) % n;
    const a = (i + n - 1) % n, b = (e + 1) % n; // the run includes the points either side of the flat ones
    if (dist(Q[a]!, Q[b]!) >= minLen) runs.push([a, b]);
    k += (e - i + n) % n;
  }
  return runs;
}

/** The points from index a to b along the ring (inclusive, wrapping; a whole loop when a === b). */
function span(Q: readonly Vec2[], a: number, b: number): Vec2[] {
  const n = Q.length;
  const out: Vec2[] = [Q[a]!];
  for (let k = (a + 1) % n; ; k = (k + 1) % n) {
    out.push(Q[k]!);
    if (k === b) return out;
  }
}

/** Unit tangent at point i, along the ring, from the points `w` mm either side. */
function tangentAt(Q: readonly Vec2[], i: number, w: number): Vec2 {
  return unit(sub(Q[walk(Q, i, w)]!, Q[walk(Q, i, -w)]!));
}

/** Largest distance (mm) the cubics run inside the outline, measured at the span's points. `outward` is +1 when
 * the outline is counter-clockwise (its outside is to the right of travel), else -1. */
function inwardError(points: readonly Vec2[], cubics: readonly Cubic[], outward: number): number {
  let worst = 0;
  for (const q of points) {
    let best = { d: Infinity, inside: 0 };
    for (const c of cubics) {
      const r = nearestOnCubic(c, q, 16);
      if (r.dist >= best.d) continue;
      const tan = derivative(c, r.t), off = sub(q, r.point);
      // a traced point on the outside of the curve means the curve runs inside the trace there
      const outside = (tan[0] * off[1] - tan[1] * off[0]) * -outward > 0;
      best = { d: r.dist, inside: outside ? r.dist : 0 };
    }
    worst = Math.max(worst, best.inside);
  }
  return worst;
}

/** A closed Bézier path fitted to the closed outline `ring` (mm). */
export function fitOutline(ring: Ring, o: FitOptions = FIT): BezierPath {
  const Q = openRing(ring);
  const n = Q.length;
  if (n < 3) return { anchors: Q.map((p) => ({ p, hin: [0, 0], hout: [0, 0], kind: 'corner' as const })) };
  const outward = signedArea(Q) > 0 ? 1 : -1;

  // corners: local maxima of the turn above the threshold, at most one per window
  const turns = Q.map((_, i) => turn(Q, i, o.cornerWindow));
  const corners = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (turns[i]! < o.cornerDeg) continue;
    const lo = walk(Q, i, -o.cornerWindow), hi = walk(Q, i, o.cornerWindow);
    let isMax = true;
    for (let k = lo; k !== hi; k = (k + 1) % n) {
      if (turns[k]! > turns[i]! || (turns[k] === turns[i] && corners.has(k))) isMax = false;
    }
    if (isMax) corners.add(i);
  }
  // arc length along the ring, to measure how far apart two points are
  const at: number[] = [0];
  for (let i = 1; i < n; i++) at.push(at[i - 1]! + dist(Q[i]!, Q[i - 1]!));
  const perimeter = at[n - 1]! + dist(Q[n - 1]!, Q[0]!);
  const apart = (i: number, j: number) => {
    const d = Math.abs(at[i]! - at[j]!);
    return Math.min(d, perimeter - d);
  };
  // straight runs without a corner inside them, their ends moved onto a corner within a window of them where
  // the segment still passes within the inward limit of every point it then covers
  const offLine = (a: number, b: number) => {
    const d = sub(Q[b]!, Q[a]!), l = len(d) || 1;
    return Math.max(...span(Q, a, b).map((q) => Math.abs(d[0] * (q[1] - Q[a]![1]) - d[1] * (q[0] - Q[a]![0])) / l));
  };
  const inside = (a: number, b: number, c: number) => (c - a + n) % n > 0 && (c - a + n) % n < (b - a + n) % n;
  const runs = straightRuns(Q, o.minStraight)
    .filter(([a, b]) => ![...corners].some((c) => inside(a, b, c)))
    .map(([a, b]): [number, number] => {
      const ca = [...corners].find((c) => apart(c, a) <= o.cornerWindow && !inside(a, b, c));
      if (ca !== undefined && offLine(ca, b) <= o.inward) a = ca;
      const cb = [...corners].find((c) => apart(c, b) <= o.cornerWindow && !inside(a, b, c));
      if (cb !== undefined && offLine(a, cb) <= o.inward) b = cb;
      return [a, b];
    })
    .filter(([a, b]) => a !== b);
  const breaks = new Set<number>(corners);
  for (const [a, b] of runs) {
    breaks.add(a);
    breaks.add(b);
  }
  // a smooth loop: four smooth anchors a quarter of the way round from each other
  if (!breaks.size) for (let q = 0; q < 4; q++) breaks.add(at.findIndex((s) => s >= (q * perimeter) / 4));
  const order = [...breaks].sort((x, y) => x - y);
  const runEnd = new Map(runs);
  /** Unit tangent forwards along the ring at a smooth break: its straight run's direction, else the ring's. */
  const forward = (i: number): Vec2 => {
    const r = runs.find(([a, b]) => a === i || b === i);
    return r ? unit(sub(Q[r[1]]!, Q[r[0]]!)) : tangentAt(Q, i, 1.5);
  };

  // the segments in order round the ring, each with the kind of the anchor it starts at
  const segs: { c: Cubic; kind: Anchor['kind'] }[] = [];
  for (let k = 0; k < order.length; k++) {
    const a = order[k]!, b = order[(k + 1) % order.length]!;
    const kindA: Anchor['kind'] = corners.has(a) ? 'corner' : 'smooth';
    if (runEnd.get(a) === b) {
      segs.push({ c: [Q[a]!, Q[a]!, Q[b]!, Q[b]!], kind: kindA });
      continue;
    }
    const pts = span(Q, a, b);
    // tangents into the span: at a corner from the span's own first or last few points, else along the ring
    const step = Math.max(1, Math.round(pts.length / 20));
    const t1 = corners.has(a) ? unit(sub(pts[Math.min(step, pts.length - 1)]!, pts[0]!)) : forward(a);
    const t2 = corners.has(b) ? unit(sub(pts[Math.max(0, pts.length - 1 - step)]!, pts[pts.length - 1]!)) : scale(forward(b), -1);
    let cubics = fitCubics(pts, o.tolerance ** 2, t1, t2);
    for (let tol = o.tolerance / 2; inwardError(pts, cubics, outward) > o.inward && tol > 0.02; tol /= 2) {
      cubics = fitCubics(pts, tol ** 2, t1, t2);
    }
    cubics.forEach((c, j) => segs.push({ c, kind: j === 0 ? kindA : 'smooth' }));
  }
  // anchor k starts segment k: out-handle from it, in-handle from the segment before
  return {
    anchors: segs.map(({ c, kind }, k) => {
      const prev = segs[(k + segs.length - 1) % segs.length]!.c;
      return { p: c[0], hout: sub(c[1], c[0]), hin: sub(prev[2], prev[3]), kind };
    }),
  };
}
