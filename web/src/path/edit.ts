// Editing a part's outline path: the operations behind the Outline pane's gestures, all pure (path in, new
// path out). The traced outline stays the reference: deleting a point refits the merged span to it, and the
// Detail slider refits the whole outline from it.
import { signedArea, type Ring, type Vec2 } from '../geometry/pocket';
import {
  add, derivative, dist, dot, evaluate, isStraight, len, makeCorner, makeSmooth, scale, segment, split, sub, type Anchor, type BezierPath,
} from './bezier';
import { FIT, fitCubics, fitOutline } from './fit';
import { checkRing, toRing } from './ring';

/** Straight segments within this many degrees of horizontal or vertical snap to it while a point moves. */
export const SNAP_DEG = 2;

const clonePath = (path: BezierPath): BezierPath => ({ anchors: path.anchors.map((a) => ({ ...a })) });
const unit = (v: Vec2): Vec2 => {
  const l = len(v);
  return l < 1e-12 ? [0, 0] : [v[0] / l, v[1] / l];
};
const wrap = (i: number, n: number) => ((i % n) + n) % n;

/** The outline fitted afresh to the trace, `tolerance` mm at most from it and half that inside it (the Detail
 * slider; the default 0.3 mm gives the fitter's own 0.15 mm inward limit). */
export function refit(traced: Ring, tolerance: number): BezierPath {
  return fitOutline(traced, { ...FIT, tolerance, inward: tolerance / 2 });
}

/** Whether the path makes a sound outline (see checkRing). */
export function isValid(path: BezierPath): boolean {
  return checkRing(toRing(path)).ok;
}

/** Anchor `i` moved to `to`, its handles with it. With `snap`, a straight segment on either side that ends up
 * within SNAP_DEG of horizontal or vertical is made exactly so. */
export function moveAnchor(path: BezierPath, i: number, to: Vec2, snap = true): BezierPath {
  const out = clonePath(path);
  const n = out.anchors.length;
  let p: Vec2 = [to[0], to[1]];
  if (snap) {
    for (const j of [wrap(i - 1, n), wrap(i + 1, n)]) {
      const seg = j === wrap(i - 1, n) ? segment(path, j) : segment(path, i);
      if (!isStraight(seg, 1e-6)) continue;
      const q = out.anchors[j]!.p;
      const d = sub(p, q);
      const deg = Math.abs((Math.atan2(d[1], d[0]) * 180) / Math.PI);
      const off = deg % 90;
      if (Math.min(off, 90 - off) > SNAP_DEG || len(d) < 1e-9) continue;
      const horizontal = Math.abs(d[0]) >= Math.abs(d[1]);
      p = horizontal ? [p[0], q[1]] : [q[0], p[1]];
    }
  }
  out.anchors[i] = { ...out.anchors[i]!, p };
  return out;
}

/** A handle of anchor `i` dragged to the point `to`. A smooth anchor keeps its handles on one line (the other
 * turns, keeping its length), unless `breakPair`, which makes it a corner and moves only this handle. */
export function moveHandle(path: BezierPath, i: number, side: 'in' | 'out', to: Vec2, breakPair = false): BezierPath {
  const out = clonePath(path);
  const a = out.anchors[i]!;
  const h = sub(to, a.p);
  const other = side === 'in' ? a.hout : a.hin;
  const kind = breakPair ? 'corner' : a.kind;
  const turned: Vec2 = kind === 'smooth' && len(other) > 1e-9 && len(h) > 1e-9 ? scale(unit(h), -len(other)) : other;
  out.anchors[i] = side === 'in' ? { ...a, kind, hin: h, hout: turned } : { ...a, kind, hout: h, hin: turned };
  return out;
}

/** Segment `i` bent so that its point at `t` passes through `to`: its two inner control points move, the
 * nearer one more, and a smooth anchor at either end turns its other handle to stay smooth. */
export function bendSegment(path: BezierPath, i: number, t: number, to: Vec2): BezierPath {
  const out = clonePath(path);
  const n = out.anchors.length;
  const s = Math.min(0.95, Math.max(0.05, t));
  const c = segment(path, i);
  const d = sub(to, evaluate(c, s));
  const b1 = 3 * (1 - s) * (1 - s) * s, b2 = 3 * (1 - s) * s * s;
  const den = b1 * (1 - s) + b2 * s;
  const p1 = add(c[1], scale(d, (1 - s) / den)), p2 = add(c[2], scale(d, s / den));
  const ia = wrap(i, n), ib = wrap(i + 1, n);
  const a = out.anchors[ia]!, b = out.anchors[ib]!;
  const hout = sub(p1, a.p), hin = sub(p2, b.p);
  const keep = (h: Vec2, other: Vec2, smooth: boolean): Vec2 =>
    smooth && len(other) > 1e-9 && len(h) > 1e-9 ? scale(unit(h), -len(other)) : other;
  out.anchors[ia] = { ...a, hout, hin: keep(hout, a.hin, a.kind === 'smooth') };
  out.anchors[ib] = { ...b, hin, hout: keep(hin, b.hout, b.kind === 'smooth') };
  return out;
}

/** Index of the traced point nearest to `q`. */
function nearestIndex(R: readonly Vec2[], q: Vec2): number {
  let best = 0;
  for (let k = 1; k < R.length; k++) if (dist(R[k]!, q) < dist(R[best]!, q)) best = k;
  return best;
}

/** Anchor `i` removed (a path keeps at least three), and the segment that now joins its neighbours fitted to
 * the traced points between them, leaving each neighbour along its own handle's direction (so a smooth one
 * stays smooth). */
export function deleteAnchor(path: BezierPath, i: number, traced: Ring): BezierPath {
  const n = path.anchors.length;
  if (n <= 3) return path;
  const out = clonePath(path);
  const ia = wrap(i - 1, n), ib = wrap(i + 1, n);
  const a = out.anchors[ia]!, b = out.anchors[ib]!;
  // the trace, open and running the same way round as the path
  let R = traced.slice(0, dist(traced[0]!, traced[traced.length - 1]!) < 1e-9 ? -1 : undefined);
  if (Math.sign(signedArea(R)) !== Math.sign(signedArea(path.anchors.map((x) => x.p)))) R = [...R].reverse();
  const ka = nearestIndex(R, a.p), kb = nearestIndex(R, b.p);
  const pts: Vec2[] = [a.p];
  for (let k = wrap(ka + 1, R.length); k !== kb; k = wrap(k + 1, R.length)) pts.push(R[k]!);
  pts.push(b.p);
  const t1 = len(a.hout) > 1e-9 ? a.hout : sub(b.p, a.p);
  const t2 = len(b.hin) > 1e-9 ? b.hin : sub(a.p, b.p);
  if (pts.length >= 4 && pts.length < R.length) {
    const [c] = fitCubics(pts, Infinity, t1, t2);
    // only along the direction each handle already had, and never backwards
    const l1 = Math.max(0, dot(sub(c![1], a.p), unit(t1))), l2 = Math.max(0, dot(sub(c![2], b.p), unit(t2)));
    out.anchors[ia] = { ...a, hout: len(a.hout) > 1e-9 || l1 > 0 ? scale(unit(t1), l1) : a.hout };
    out.anchors[ib] = { ...b, hin: len(b.hin) > 1e-9 || l2 > 0 ? scale(unit(t2), l2) : b.hin };
  }
  out.anchors.splice(i, 1);
  return out;
}

/** Anchor `i` toggled between corner and smooth. */
export function toggleKind(path: BezierPath, i: number): BezierPath {
  return path.anchors[i]!.kind === 'smooth' ? makeCorner(path, i) : makeSmooth(path, i);
}

/** Where along a cubic (from its end `fromEnd`, else its start) the curve is `d` mm from that end, by
 * bisection (the distance grows from 0 there); 1 or 0 past the far end. */
function paramAt(c: [Vec2, Vec2, Vec2, Vec2], d: number, fromEnd: boolean): number {
  const end = fromEnd ? c[3] : c[0];
  let lo = 0, hi = 1;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    const t = fromEnd ? 1 - mid : mid;
    if (dist(evaluate(c, t), end) < d) lo = mid;
    else hi = mid;
  }
  const m = (lo + hi) / 2;
  return fromEnd ? 1 - m : m;
}

/** Corner `i` rounded with an arc of radius `r` mm tangent to the outline either side, the way a fillet rounds
 * a corner: the two segments are cut where the arc meets them and the corner becomes two smooth points joined
 * by the arc. Where that radius needs more than 45% of either segment, the largest radius that fits is used.
 * Returns the path and the radius used (0, and the path unchanged, at a point that hardly turns). */
export function roundCorner(path: BezierPath, i: number, r: number): { path: BezierPath; radius: number } {
  const n = path.anchors.length;
  const none = { path, radius: 0 };
  if (r <= 0 || n < 3) return none;
  const ip = wrap(i - 1, n), inx = wrap(i + 1, n);
  const cin = segment(path, ip), cout = segment(path, i);
  // directions into and out of the corner
  const tin = unit(len(derivative(cin, 1)) > 1e-9 ? derivative(cin, 1) : sub(cin[3], cin[0]));
  const tout = unit(len(derivative(cout, 0)) > 1e-9 ? derivative(cout, 0) : sub(cout[3], cout[0]));
  const phi = Math.acos(Math.max(-1, Math.min(1, dot(tin, tout))));
  if (phi < (5 * Math.PI) / 180 || phi > Math.PI - 1e-3) return none;
  const d = Math.min(r * Math.tan(phi / 2), 0.45 * dist(cin[0], cin[3]), 0.45 * dist(cout[0], cout[3]));
  if (d < 1e-3) return none;
  const [inL] = split(cin, paramAt(cin, d, true));
  const [, outR] = split(cout, paramAt(cout, d, false));
  const p1 = inL[3], p2 = outR[0];
  const u1 = unit(len(derivative(inL, 1)) > 1e-9 ? derivative(inL, 1) : sub(p1, inL[0]));
  const u2 = unit(len(derivative(outR, 0)) > 1e-9 ? derivative(outR, 0) : sub(outR[3], p2));
  // the arc between them: a cubic with handles (4/3) tan(alpha / 4) times its radius along the tangents
  const alpha = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  const radius = dist(p1, p2) / (2 * Math.sin(alpha / 2) || 1);
  const h = (4 / 3) * Math.tan(alpha / 4) * radius;
  const out = clonePath(path);
  const prev = out.anchors[ip]!, next = out.anchors[inx]!;
  out.anchors[ip] = { ...prev, hout: sub(inL[1], inL[0]) };
  out.anchors[inx] = { ...next, hin: sub(outR[2], outR[3]) };
  const a1: Anchor = { p: p1, hin: sub(inL[2], inL[3]), hout: scale(u1, h), kind: 'smooth' };
  const a2: Anchor = { p: p2, hin: scale(u2, -h), hout: sub(outR[1], outR[0]), kind: 'smooth' };
  // a straight side stays a straight segment up to the arc (its handle along the side is left at zero length)
  if (isStraight(cin)) a1.hin = [0, 0];
  if (isStraight(cout)) a2.hout = [0, 0];
  out.anchors.splice(i, 1, a1, a2);
  return { path: out, radius: d / Math.tan(phi / 2) };
}
