// Mirrored outline editing for symmetric parts. The outline is one half, a chain of anchors from where it
// crosses the part's mirror axis at one end (B) to where it crosses at the other (T), plus that half mirrored
// about the axis: [B, r1 … rk, T, m(rk) … m(r1)]. Edits to either side are made to the half, so the outline
// stays exactly symmetric. B and T stay on the axis; when smooth, their handles are square to it, so the halves
// join without a kink.
import { rotate, type Ring, type Vec2 } from '../geometry/pocket';
import { dist, dot, insertAnchor, len, scale, straightenSegment, sub, type Anchor, type BezierPath } from './bezier';
import { bendSegment, deleteAnchor, moveAnchor, moveHandle, roundCorner, toggleKind } from './edit';
import { FIT, fitOutline } from './fit';

/** The mirror axis: through `centre` shifted sideways by `offset`, at `deg` from the y axis (as symmetrize). */
export interface Axis {
  deg: number;
  offset: number;
  centre: Vec2;
}

/** Into the axis frame, where the axis is the line x = 0, and back. */
const toAxis = (a: Axis, p: Vec2): Vec2 => {
  const [x, y] = rotate([[p[0] - a.centre[0], p[1] - a.centre[1]]], -a.deg)[0]!;
  return [x - a.offset, y];
};
const fromAxis = (a: Axis, q: Vec2): Vec2 => {
  const [x, y] = rotate([[q[0] + a.offset, q[1]]], a.deg)[0]!;
  return [x + a.centre[0], y + a.centre[1]];
};

/** A point mirrored about the axis. */
export function mirrorPoint(a: Axis, p: Vec2): Vec2 {
  const [x, y] = toAxis(a, p);
  return fromAxis(a, [-x, y]);
}

/** A direction (a handle) mirrored about the axis. */
export function mirrorVec(a: Axis, v: Vec2): Vec2 {
  const [x, y] = rotate([v], -a.deg)[0]!;
  return rotate([[-x, y]], a.deg)[0]!;
}

/** The unit direction square to the axis, towards the half's side (+x in the axis frame). */
const across = (a: Axis): Vec2 => rotate([[1, 0]], a.deg)[0]!;

/** The point on the axis nearest to `p`. */
const ontoAxis = (a: Axis, p: Vec2): Vec2 => fromAxis(a, [0, toAxis(a, p)[1]]);

/** The whole outline from its half. */
export function fullFromHalf(a: Axis, half: BezierPath): BezierPath {
  const h = half.anchors.length;
  const B = half.anchors[0]!, T = half.anchors[h - 1]!;
  const mid = half.anchors.slice(1, h - 1);
  return {
    anchors: [
      { ...B, hin: mirrorVec(a, B.hout) },
      ...mid.map((x) => ({ ...x })),
      { ...T, hout: mirrorVec(a, T.hin) },
      ...[...mid].reverse().map((x): Anchor => ({ p: mirrorPoint(a, x.p), hin: mirrorVec(a, x.hout), hout: mirrorVec(a, x.hin), kind: x.kind })),
    ],
  };
}

/** The half of a whole outline made by fullFromHalf, or null if it can't be one (an odd count, or fewer than 4). */
export function halfFromFull(full: BezierPath): BezierPath | null {
  const n = full.anchors.length;
  if (n < 4 || n % 2) return null;
  const h = n / 2 + 1;
  const anchors = full.anchors.slice(0, h).map((x) => ({ ...x }));
  anchors[0] = { ...anchors[0]!, hin: [0, 0] };
  anchors[h - 1] = { ...anchors[h - 1]!, hout: [0, 0] };
  return { anchors };
}

/** Which half anchor a whole-outline anchor is, and whether it is on the mirrored side. */
export function mapAnchor(h: number, i: number): { j: number; mirrored: boolean } {
  const n = 2 * h - 2;
  return i <= h - 1 ? { j: i, mirrored: false } : { j: n - i, mirrored: true };
}

/** Which half segment a whole-outline segment is (anchor i to i+1), and whether it runs the other way. */
export function mapSegment(h: number, i: number): { j: number; reversed: boolean } {
  const n = 2 * h - 2;
  return i <= h - 2 ? { j: i, reversed: false } : { j: n - 1 - i, reversed: true };
}

/** The half with B and T on the axis and, where smooth, their handles square to it (on the half's side). */
export function constrainEnds(a: Axis, half: BezierPath): BezierPath {
  const h = half.anchors.length;
  const anchors = half.anchors.map((x) => ({ ...x }));
  const u = across(a);
  const end = (k: number, side: 'hin' | 'hout') => {
    const x = anchors[k]!;
    const p = ontoAxis(a, x.p);
    const handle = x[side];
    let next = handle;
    if (x.kind === 'smooth') {
      const other = anchors[k === 0 ? 1 : h - 2]!.p;
      const l = Math.max(dot(handle, u), len(handle) > 1e-9 ? 0.1 : dist(p, other) / 3);
      next = scale(u, l);
    }
    anchors[k] = { ...x, p, [side]: next, [side === 'hin' ? 'hout' : 'hin']: [0, 0] };
  };
  end(0, 'hout');
  end(h - 1, 'hin');
  return { anchors };
}

/** The traced symmetric outline's half: where it crosses the axis, and the closed ring of that half with the
 * axis between its ends (to fit, and to refit a deleted point against). Null unless it crosses the axis exactly
 * twice (an outline that crosses it more often has more than one half on a side). */
export function halfRing(a: Axis, traced: Ring): { ring: Ring; B: Vec2; T: Vec2 } | null {
  const P = traced.length > 1 && dist(traced[0]!, traced[traced.length - 1]!) < 1e-9 ? traced.slice(0, -1) : traced;
  const Q = P.map((p) => toAxis(a, p));
  const n = Q.length;
  const cross: { k: number; f: number; q: Vec2 }[] = [];
  for (let k = 0; k < n; k++) {
    const p = Q[k]!, q = Q[(k + 1) % n]!;
    if ((p[0] <= 0 && q[0] > 0) || (p[0] > 0 && q[0] <= 0)) {
      const f = p[0] === q[0] ? 0 : -p[0] / (q[0] - p[0]);
      cross.push({ k, f, q: [0, p[1] + f * (q[1] - p[1])] });
    }
  }
  if (cross.length !== 2) return null;
  const [c0, c1] = cross[0]!.q[1] < cross[1]!.q[1] ? [cross[0]!, cross[1]!] : [cross[1]!, cross[0]!];
  // from B along the side with x > 0 to T
  const half: Vec2[] = [c0.q];
  const forward = Q[(c0.k + 1) % n]![0] > 0;
  for (let k = forward ? (c0.k + 1) % n : c0.k, guard = 0; guard < n; guard++) {
    half.push(Q[k]!);
    const next = forward ? (k + 1) % n : (k - 1 + n) % n;
    if ((forward ? k : next) === c1.k) break;
    k = next;
  }
  half.push(c1.q);
  // back down the axis, about every half millimetre
  const span = c1.q[1] - c0.q[1];
  const steps = Math.max(2, Math.ceil(span / 0.5));
  for (let s = steps - 1; s >= 1; s--) half.push([0, c0.q[1] + (span * s) / steps]);
  return { ring: [...half.map((q) => fromAxis(a, q)), fromAxis(a, half[0]!)], B: fromAxis(a, c0.q), T: fromAxis(a, c1.q) };
}

/** A half fitted to the traced symmetric outline at `tolerance` mm (the Detail slider), or null if the outline
 * doesn't cross its axis exactly twice. B and T are smooth where the outline crosses the axis nearly square to
 * it (within 25 degrees), else corners (a pointed tip). */
export function fitHalf(a: Axis, traced: Ring, tolerance: number): { half: BezierPath; ring: Ring } | null {
  const hr = halfRing(a, traced);
  if (!hr) return null;
  const fitted = fitOutline(hr.ring, { ...FIT, tolerance, inward: tolerance / 2 });
  const A = fitted.anchors;
  const nearest = (p: Vec2) => A.reduce((best, x, k) => (dist(x.p, p) < dist(A[best]!.p, p) ? k : best), 0);
  const ib = nearest(hr.B), it = nearest(hr.T);
  if (dist(A[ib]!.p, hr.B) > 1 || dist(A[it]!.p, hr.T) > 1 || ib === it) return null;
  // walk from B the way that leaves the axis (into x > 0), to T
  const m = A.length;
  const step = toAxis(a, A[(ib + 1) % m]!.p)[0] > 1e-6 ? 1 : -1;
  const chain: Anchor[] = [];
  for (let k = ib, guard = 0; guard <= m; guard++, k = (k + step + m) % m) {
    const x = A[k]!;
    // walking backwards, each anchor's in and out handles swap
    chain.push(step > 0 ? { ...x } : { ...x, hin: x.hout, hout: x.hin });
    if (k === it) break;
  }
  if (chain.length < 3) return null;
  chain[0] = { ...chain[0]!, p: hr.B };
  chain[chain.length - 1] = { ...chain[chain.length - 1]!, p: hr.T };
  // smooth ends where the half meets the axis nearly square to it
  const u = across(a);
  const squareTo = (v: Vec2) => len(v) > 1e-9 && dot(v, u) / len(v) > Math.cos((25 * Math.PI) / 180);
  const B = chain[0]!, T = chain[chain.length - 1]!;
  const dirB = len(B.hout) > 1e-9 ? B.hout : sub(chain[1]!.p, B.p);
  const dirT = len(T.hin) > 1e-9 ? T.hin : sub(chain[chain.length - 2]!.p, T.p);
  chain[0] = { ...B, kind: squareTo(dirB) ? 'smooth' : 'corner' };
  chain[chain.length - 1] = { ...T, kind: squareTo(dirT) ? 'smooth' : 'corner' };
  return { half: constrainEnds(a, { anchors: chain }), ring: hr.ring };
}

// ---- edits to either side of the whole outline, made to the half

/** Anchor i of the whole outline moved to `to`; B and T slide along the axis. */
export function mirrorMoveAnchor(a: Axis, half: BezierPath, i: number, to: Vec2, snap = true): BezierPath {
  const h = half.anchors.length;
  const { j, mirrored } = mapAnchor(h, i);
  const target = mirrored ? mirrorPoint(a, to) : to;
  if (j === 0 || j === h - 1) {
    const anchors = half.anchors.map((x) => ({ ...x }));
    anchors[j] = { ...anchors[j]!, p: ontoAxis(a, target) };
    return constrainEnds(a, { anchors });
  }
  return constrainEnds(a, moveAnchor(half, j, target, snap));
}

/** A handle of anchor i of the whole outline dragged to `to` (Alt: `breakPair`). */
export function mirrorMoveHandle(a: Axis, half: BezierPath, i: number, side: 'in' | 'out', to: Vec2, breakPair = false): BezierPath {
  const h = half.anchors.length;
  const { j, mirrored } = mapAnchor(h, i);
  let s: 'in' | 'out' = mirrored ? (side === 'in' ? 'out' : 'in') : side;
  let t = mirrored ? mirrorPoint(a, to) : to;
  // B's in-handle and T's out-handle are the mirror of their other one
  if ((j === 0 && s === 'in') || (j === h - 1 && s === 'out')) {
    s = s === 'in' ? 'out' : 'in';
    t = mirrorPoint(a, t);
  }
  if (j === 0 || j === h - 1) {
    const anchors = half.anchors.map((x) => ({ ...x }));
    const x = anchors[j]!;
    anchors[j] = { ...x, kind: breakPair ? 'corner' : x.kind, [s === 'in' ? 'hin' : 'hout']: sub(t, x.p) };
    return constrainEnds(a, { anchors });
  }
  return constrainEnds(a, moveHandle(half, j, s, t, breakPair));
}

/** Segment i of the whole outline bent so its point at `t` passes through `to`. */
export function mirrorBend(a: Axis, half: BezierPath, i: number, t: number, to: Vec2): BezierPath {
  const { j, reversed } = mapSegment(half.anchors.length, i);
  return constrainEnds(a, bendSegment(half, j, reversed ? 1 - t : t, reversed ? mirrorPoint(a, to) : to));
}

/** A point added on segment i of the whole outline at `t` (and its mirror); the new point's whole-outline index. */
export function mirrorInsert(a: Axis, half: BezierPath, i: number, t: number): { half: BezierPath; index: number } {
  const h = half.anchors.length;
  const { j, reversed } = mapSegment(h, i);
  const { path, index } = insertAnchor(half, j, reversed ? 1 - t : t);
  const h2 = path.anchors.length;
  return { half: constrainEnds(a, path), index: reversed ? 2 * h2 - 2 - index : index };
}

/** Anchor i of the whole outline (and its mirror) removed and the gap refitted to the half's ring; null for B or
 * T, or when the half would have no point between them. */
export function mirrorDelete(a: Axis, half: BezierPath, i: number, ring: Ring): BezierPath | null {
  const h = half.anchors.length;
  const { j } = mapAnchor(h, i);
  if (j === 0 || j === h - 1 || h <= 3) return null;
  return constrainEnds(a, deleteAnchor(half, j, ring));
}

/** Anchor i of the whole outline switched between corner and smooth. */
export function mirrorToggle(a: Axis, half: BezierPath, i: number): BezierPath {
  const h = half.anchors.length;
  const { j } = mapAnchor(h, i);
  if (j !== 0 && j !== h - 1) return toggleKind(half, j);
  const anchors = half.anchors.map((x) => ({ ...x }));
  anchors[j] = { ...anchors[j]!, kind: anchors[j]!.kind === 'smooth' ? 'corner' : 'smooth' };
  return constrainEnds(a, { anchors });
}

/** Segment i of the whole outline made straight. */
export function mirrorStraighten(a: Axis, half: BezierPath, i: number): BezierPath {
  return constrainEnds(a, straightenSegment(half, mapSegment(half.anchors.length, i).j));
}

/** Corner i of the whole outline rounded (not B or T, which stay on the axis); radius 0 when nothing changed. */
export function mirrorRound(a: Axis, half: BezierPath, i: number, r: number): { half: BezierPath; radius: number } {
  const h = half.anchors.length;
  const { j } = mapAnchor(h, i);
  if (j === 0 || j === h - 1) return { half, radius: 0 };
  const { path, radius } = roundCorner(half, j, r);
  return { half: constrainEnds(a, path), radius };
}

/** Whether a whole outline is the mirror image of itself about the axis (to `eps` mm). */
export function isMirrored(a: Axis, full: BezierPath, eps = 1e-6): boolean {
  const n = full.anchors.length;
  return full.anchors.every((x, i) => {
    const y = full.anchors[(n - i) % n]!;
    return dist(mirrorPoint(a, x.p), y.p) < eps && dist(mirrorVec(a, x.hout), y.hin) < eps && dist(mirrorVec(a, x.hin), y.hout) < eps;
  });
}

