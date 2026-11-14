// From an edited Bézier path back to the outline ring the pocket geometry takes, and the checks that keep an
// edit from producing an outline it would silently mangle (makePocket fills with NonZero and keeps the largest
// part, so a figure-eight would lose a lobe instead of failing).
import { signedArea, type Ring, type Vec2 } from '../geometry/pocket';
import { dist, flattenCubic, segment, type BezierPath } from './bezier';

/** `path` as an outline ring of `n` points (the last repeating the first, as traced outlines are): each segment
 * flattened to within `tol` mm, the points spread by arc length, and every anchor on a point, so corners stay
 * sharp. */
export function toRing(path: BezierPath, n = 720, tol = 0.02): Ring {
  const m = n - 1;
  const segs = path.anchors.map((_, i) => {
    const c = segment(path, i);
    const pts = [...flattenCubic(c, tol), c[3]];
    const s = [0];
    for (let k = 1; k < pts.length; k++) s.push(s[k - 1]! + dist(pts[k]!, pts[k - 1]!));
    return { pts, s, length: s[s.length - 1]! };
  });
  const total = segs.reduce((a, g) => a + g.length, 0);
  if (!(total > 0) || segs.length > m) return [...path.anchors.map((a) => a.p), path.anchors[0]!.p];
  // points per segment, by length, at least one (its start anchor); rounding fixed on the longest
  const counts = segs.map((g) => Math.max(1, Math.round((m * g.length) / total)));
  for (let diff = m - counts.reduce((a, c) => a + c, 0); diff !== 0; diff -= Math.sign(diff)) {
    let k = 0;
    for (let j = 1; j < segs.length; j++) {
      if (diff > 0 ? segs[j]!.length / counts[j]! > segs[k]!.length / counts[k]! : counts[j]! > counts[k]! && counts[j]! > 1) k = j;
    }
    if (diff < 0 && counts[k]! <= 1) break;
    counts[k]! += Math.sign(diff);
  }
  const out: Vec2[] = [];
  segs.forEach(({ pts, s, length }, i) => {
    const c = counts[i]!;
    let j = 0;
    for (let k = 0; k < c; k++) {
      const at = (k * length) / c;
      while (j < pts.length - 2 && s[j + 1]! < at) j++;
      const span = s[j + 1]! - s[j]!;
      const f = span > 0 ? (at - s[j]!) / span : 0;
      out.push([pts[j]![0] + (pts[j + 1]![0] - pts[j]![0]) * f, pts[j]![1] + (pts[j + 1]![1] - pts[j]![1]) * f]);
    }
  });
  return [...out, out[0]!];
}

export interface RingCheck {
  ok: boolean;
  /** Pairs of edges (by their first point's index) that cross. */
  crossings: [number, number][];
  /** Points where the outline folds back on itself (a turn sharper than `spikeDeg`). */
  spikes: number[];
  /** Edges shorter than 1e-6 mm. */
  zeroEdges: number[];
  /** Signed area (mm², positive counter-clockwise). */
  area: number;
}

const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Whether segments ab and cd properly cross or touch. */
function intersects(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (p: Vec2, q: Vec2, r: Vec2) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0])
    && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  return (d1 === 0 && on(c, d, a)) || (d2 === 0 && on(c, d, b)) || (d3 === 0 && on(a, b, c)) || (d4 === 0 && on(a, b, d));
}

/** Check a closed ring (last point may repeat the first) for what would break a pocket: crossings between
 * edges that aren't neighbours, spikes, zero-length edges, and an area under `minArea` mm². */
export function checkRing(ring: Ring, { minArea = 4, spikeDeg = 175 } = {}): RingCheck {
  const P = ring.length > 1 && dist(ring[0]!, ring[ring.length - 1]!) < 1e-12 ? ring.slice(0, -1) : ring;
  const n = P.length;
  const crossings: [number, number][] = [];
  const spikes: number[] = [];
  const zeroEdges: number[] = [];
  const box = P.map((p, i) => {
    const q = P[(i + 1) % n]!;
    return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])] as const;
  });
  const cosSpike = Math.cos((spikeDeg * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    const a = P[i]!, b = P[(i + 1) % n]!;
    if (dist(a, b) < 1e-6) zeroEdges.push(i);
    const c = P[(i + 2) % n]!;
    const u: Vec2 = [b[0] - a[0], b[1] - a[1]], v: Vec2 = [c[0] - b[0], c[1] - b[1]];
    const lu = Math.hypot(u[0], u[1]), lv = Math.hypot(v[0], v[1]);
    // the angle between consecutive edges: a fold back is close to 180 degrees
    if (lu > 1e-9 && lv > 1e-9 && (u[0] * v[0] + u[1] * v[1]) / (lu * lv) < cosSpike) spikes.push((i + 1) % n);
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // neighbours across the seam
      const bi = box[i]!, bj = box[j]!;
      if (bi[2] < bj[0] || bj[2] < bi[0] || bi[3] < bj[1] || bj[3] < bi[1]) continue;
      if (intersects(a, b, P[j]!, P[(j + 1) % n]!)) crossings.push([i, j]);
    }
  }
  const area = signedArea(P);
  return { ok: !crossings.length && !spikes.length && !zeroEdges.length && Math.abs(area) >= minArea, crossings, spikes, zeroEdges, area };
}
