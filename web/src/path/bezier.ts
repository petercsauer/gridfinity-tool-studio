// Closed cubic Bézier paths for editing traced outlines: anchors on the outline with in and out handles, each
// a corner (handles independent, or none) or smooth (handles collinear, G1). Segment i runs from anchor i to
// anchor i+1 (the last one back to the first). All coordinates are mm.
import type { Ring, Vec2 } from '../geometry/pocket';

export type AnchorKind = 'corner' | 'smooth';

export interface Anchor {
  /** The point on the outline. */
  p: Vec2;
  /** Handles relative to `p`: towards the previous anchor (in) and the next (out). [0, 0] for none. */
  hin: Vec2;
  hout: Vec2;
  kind: AnchorKind;
}

export interface BezierPath {
  anchors: Anchor[];
}

/** The four control points of a cubic segment. */
export type Cubic = [Vec2, Vec2, Vec2, Vec2];

export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
export const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
export const len = (a: Vec2) => Math.hypot(a[0], a[1]);
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Control points of segment `i` (anchor i to anchor i+1, wrapping). */
export function segment(path: BezierPath, i: number): Cubic {
  const n = path.anchors.length;
  const a = path.anchors[((i % n) + n) % n]!;
  const b = path.anchors[(((i + 1) % n) + n) % n]!;
  return [a.p, add(a.p, a.hout), add(b.p, b.hin), b.p];
}

/** Whether a segment is a straight line (both handles on the chord, or none). */
export function isStraight([p0, p1, p2, p3]: Cubic, eps = 1e-9): boolean {
  const d = sub(p3, p0);
  const l = len(d);
  if (l < eps) return true;
  const off = (q: Vec2) => Math.abs(d[0] * (q[1] - p0[1]) - d[1] * (q[0] - p0[0])) / l;
  return off(p1) < eps && off(p2) < eps;
}

/** The point at `t` (de Casteljau). */
export function evaluate([p0, p1, p2, p3]: Cubic, t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

/** First derivative at `t`. */
export function derivative([p0, p1, p2, p3]: Cubic, t: number): Vec2 {
  const u = 1 - t;
  const a = 3 * u * u, b = 6 * u * t, c = 3 * t * t;
  return [
    a * (p1[0] - p0[0]) + b * (p2[0] - p1[0]) + c * (p3[0] - p2[0]),
    a * (p1[1] - p0[1]) + b * (p2[1] - p1[1]) + c * (p3[1] - p2[1]),
  ];
}

/** Second derivative at `t`. */
export function derivative2([p0, p1, p2, p3]: Cubic, t: number): Vec2 {
  const u = 1 - t;
  return [
    6 * u * (p2[0] - 2 * p1[0] + p0[0]) + 6 * t * (p3[0] - 2 * p2[0] + p1[0]),
    6 * u * (p2[1] - 2 * p1[1] + p0[1]) + 6 * t * (p3[1] - 2 * p2[1] + p1[1]),
  ];
}

/** The cubic split at `t` into two that trace exactly the same curve (de Casteljau). */
export function split([p0, p1, p2, p3]: Cubic, t: number): [Cubic, Cubic] {
  const a = lerp(p0, p1, t), b = lerp(p1, p2, t), c = lerp(p2, p3, t);
  const d = lerp(a, b, t), e = lerp(b, c, t);
  const m = lerp(d, e, t);
  return [[p0, a, d, m], [m, e, c, p3]];
}

/** The path with an anchor inserted on segment `i` at `t`, the shape unchanged. The new anchor is smooth
 * (its handles come out collinear) unless the segment is straight, where it is a handle-less corner.
 * Returns the new path and the new anchor's index. */
export function insertAnchor(path: BezierPath, i: number, t: number): { path: BezierPath; index: number } {
  const n = path.anchors.length;
  const seg = segment(path, i);
  const [l, r] = split(seg, t);
  const anchors = path.anchors.map((a) => ({ ...a }));
  const a = anchors[i % n]!, b = anchors[(i + 1) % n]!;
  a.hout = sub(l[1], l[0]);
  b.hin = sub(r[2], r[3]);
  const straight = isStraight(seg);
  const mid: Anchor = {
    p: l[3],
    hin: straight ? [0, 0] : sub(l[2], l[3]),
    hout: straight ? [0, 0] : sub(r[1], r[0]),
    kind: straight ? 'corner' : 'smooth',
  };
  anchors.splice((i % n) + 1, 0, mid);
  return { path: { anchors }, index: (i % n) + 1 };
}

/** The closest point of one cubic to `q`: parameter, point and distance (coarse sampling, then Newton). */
export function nearestOnCubic(c: Cubic, q: Vec2, samples = 32): { t: number; point: Vec2; dist: number } {
  let t = 0, d0 = Infinity;
  for (let k = 0; k <= samples; k++) {
    const d = dist(evaluate(c, k / samples), q);
    if (d < d0) { d0 = d; t = k / samples; }
  }
  // Newton on f(t) = (B(t) - q) . B'(t)
  for (let k = 0; k < 6; k++) {
    const p = sub(evaluate(c, t), q), d1 = derivative(c, t), d2 = derivative2(c, t);
    const den = dot(d1, d1) + dot(p, d2);
    if (Math.abs(den) < 1e-12) break;
    t = Math.min(1, Math.max(0, t - dot(p, d1) / den));
  }
  const point = evaluate(c, t);
  return { t, point, dist: dist(point, q) };
}

/** The closest point of the path to `q`: segment, parameter, point and distance. */
export function nearest(path: BezierPath, q: Vec2, samples = 32): { seg: number; t: number; point: Vec2; dist: number } {
  let best = { seg: 0, t: 0, point: path.anchors[0]!.p, dist: Infinity };
  for (let i = 0; i < path.anchors.length; i++) {
    const r = nearestOnCubic(segment(path, i), q, samples);
    if (r.dist < best.dist) best = { seg: i, ...r };
  }
  return best;
}

/** Distance from `q` to the chord p0-p3. */
function chordDistance(q: Vec2, p0: Vec2, p3: Vec2): number {
  const d = sub(p3, p0);
  const l2 = dot(d, d);
  if (l2 < 1e-24) return dist(q, p0);
  const t = Math.max(0, Math.min(1, dot(sub(q, p0), d) / l2));
  return dist(q, add(p0, scale(d, t)));
}

/** The segment as points from its start (included) to its end (excluded), each chord within `tol` mm of the
 * curve: recursive subdivision until both inner control points lie within `tol` of the chord (the curve lies
 * in the control polygon's hull, so it is then within `tol` too). */
export function flattenCubic(c: Cubic, tol: number, depth = 0): Vec2[] {
  if (depth >= 16 || (chordDistance(c[1], c[0], c[3]) <= tol && chordDistance(c[2], c[0], c[3]) <= tol)) return [c[0]];
  const [l, r] = split(c, 0.5);
  return [...flattenCubic(l, tol, depth + 1), ...flattenCubic(r, tol, depth + 1)];
}

/** The whole path flattened to within `tol` mm, and the index in it where each anchor lands. */
export function flatten(path: BezierPath, tol = 0.02): { points: Ring; anchorAt: number[] } {
  const points: Vec2[] = [];
  const anchorAt: number[] = [];
  for (let i = 0; i < path.anchors.length; i++) {
    anchorAt.push(points.length);
    points.push(...flattenCubic(segment(path, i), tol));
  }
  return { points, anchorAt };
}

/** Make anchor `i` smooth: its handles turned onto one line along the bisector of the directions to its
 * neighbours, each keeping its length (or a third of the way to its neighbour where it had none). */
export function makeSmooth(path: BezierPath, i: number): BezierPath {
  const n = path.anchors.length;
  const anchors = path.anchors.map((a) => ({ ...a }));
  const a = anchors[i]!, prev = anchors[(i + n - 1) % n]!, next = anchors[(i + 1) % n]!;
  const toNext = sub(next.p, a.p), toPrev = sub(prev.p, a.p);
  const ln = len(toNext), lp = len(toPrev);
  if (ln < 1e-9 || lp < 1e-9) return path;
  let dir = sub(scale(toNext, 1 / ln), scale(toPrev, 1 / lp));
  const dl = len(dir);
  dir = dl < 1e-9 ? [-toNext[1] / ln, toNext[0] / ln] : scale(dir, 1 / dl);
  const lo = len(a.hout) || ln / 3, li = len(a.hin) || lp / 3;
  anchors[i] = { ...a, kind: 'smooth', hout: scale(dir, lo), hin: scale(dir, -li) };
  return { anchors };
}

/** Make anchor `i` a corner, keeping its handles where they are. */
export function makeCorner(path: BezierPath, i: number): BezierPath {
  const anchors = path.anchors.map((a) => ({ ...a }));
  anchors[i] = { ...anchors[i]!, kind: 'corner' };
  return { anchors };
}

/** Make segment `i` straight: the handles at both its ends removed, and those ends made corners. */
export function straightenSegment(path: BezierPath, i: number): BezierPath {
  const n = path.anchors.length;
  const anchors = path.anchors.map((a) => ({ ...a }));
  const a = anchors[i % n]!, b = anchors[(i + 1) % n]!;
  anchors[i % n] = { ...a, hout: [0, 0], kind: 'corner' };
  anchors[(i + 1) % n] = { ...b, hin: [0, 0], kind: 'corner' };
  return { anchors };
}
