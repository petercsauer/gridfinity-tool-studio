// Symmetric outline that contains the tool. Mirrors symmetrize / mirror_score / _best_axis in
// src/gts/geometry.py: find the mirror axis (angle and sideways offset near the area centroid), take the
// union of the outline and its reflection, close it with a 1 mm round offset and resample it.
import type { CrossSection, ManifoldToplevel } from 'manifold-3d';
import { CIRCULAR_SEGMENTS } from '../geometry/constants';
import { ccw, rotate, signedArea, type Ring, type Vec2 } from '../geometry/pocket';
import { resample } from './smooth';

export interface SymmetricOutline {
  /** Symmetric outline in the original (upright) pose, counter-clockwise, `n` points. */
  outline: Ring;
  /** Mirror IoU of the original outline about the axis; 1 for a perfectly symmetric tool. */
  score: number;
  /** Axis angle from the y axis, degrees. */
  axisDeg: number;
  /** Sideways shift of the axis from the centroid along the rotated x axis, mm. */
  offset: number;
  /** Area centroid of the original outline. */
  centre: Vec2;
}

/** Area centroid of a closed ring (shoelace). */
export function centroid(P: Ring): Vec2 {
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < P.length; i++) {
    const [x0, y0] = P[i]!;
    const [x1, y1] = P[(i + 1) % P.length]!;
    const w = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * w;
    cy += (y0 + y1) * w;
  }
  const a = 3 * 2 * signedArea(P);
  return [cx / a, cy / a];
}

/** Points in the frame where the mirror axis (`deg`, `offset`) is the line x = 0. */
function axisFrame(P: Ring, [cx, cy]: Vec2, deg: number, offset: number): Ring {
  return rotate(P.map(([x, y]): Vec2 => [x - cx, y - cy]), -deg).map(([x, y]): Vec2 => [x - offset, y]);
}

const mirrorX = (Q: Ring): Ring => Q.map(([x, y]): Vec2 => [-x, y]);

/** IoU of the outline with its reflection about the axis `deg`/`offset` through `centre`. */
export function mirrorScore(m: ManifoldToplevel, P: Ring, centre: Vec2, deg: number, offset = 0): number {
  const Q = axisFrame(P, centre, deg, offset);
  const A = new m.CrossSection([Q], 'NonZero');
  const B = new m.CrossSection([mirrorX(Q)], 'NonZero');
  const I = A.intersect(B);
  try {
    const inter = I.area();
    return inter / (A.area() + B.area() - inter);
  } finally {
    for (const x of [A, B, I]) x.delete();
  }
}

/** Best mirror axis [deg, offset]: angle search through the centroid from -25 to 25 degrees in 0.5
 * degree steps, then two joint angle/offset grid refinements (first maximum wins, as Python's max). */
function bestAxis(m: ManifoldToplevel, P: Ring, centre: Vec2): [number, number] {
  const best = (grid: [number, number][]) => {
    let top = grid[0]!;
    let topScore = -Infinity;
    for (const g of grid) {
      const s = mirrorScore(m, P, centre, g[0], g[1]);
      if (s > topScore) {
        top = g;
        topScore = s;
      }
    }
    return top;
  };
  const range = (lo: number, hi: number, step: number) => {
    const out: number[] = [];
    for (let i = 0; lo + i * step <= hi + 1e-9; i++) out.push(lo + i * step);
    return out;
  };
  let [deg, off] = best(range(-25, 25, 0.5).map((d): [number, number] => [d, 0]));
  [deg, off] = best(range(-1, 1, 0.25).flatMap((d) => range(-3, 3, 0.25).map((o): [number, number] => [deg + d, off + o])));
  [deg, off] = best(range(-0.25, 0.25, 0.05).flatMap((d) => range(-0.25, 0.25, 0.025).map((o): [number, number] => [deg + d, off + o])));
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  return [r4(deg), r4(off)];
}

/** Outer contour of the largest part of a cross-section. */
function largestRing(cs: CrossSection): Ring {
  let best: Ring = [];
  let bestArea = 0;
  for (const poly of cs.toPolygons()) {
    const ring = poly.map(([x, y]): Vec2 => [x, y]);
    const a = Math.abs(signedArea(ring));
    if (a > bestArea) {
      best = ring;
      bestArea = a;
    }
  }
  if (!best.length) throw new Error('The symmetric outline has no area.');
  return best;
}

/** Make a symmetric tool's outline exactly symmetric without shrinking or moving it: the union of the
 * outline and its reflection about the tool's own mirror axis, closed with a round offset of `smooth` mm
 * and resampled to `n` points, in the original pose. */
export function symmetrize(m: ManifoldToplevel, P: Ring, smooth = 1.0, n = 720): SymmetricOutline {
  const c = centroid(P);
  const [deg, off] = bestAxis(m, P, c);
  const Q = axisFrame(P, c, deg, off);
  const live: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T) => (live.push(x), x);
  try {
    const union = keep(keep(new m.CrossSection([Q], 'NonZero')).add(keep(new m.CrossSection([mirrorX(Q)], 'NonZero'))));
    const closed = keep(keep(union.offset(smooth, 'Round', 2, CIRCULAR_SEGMENTS)).offset(-smooth, 'Round', 2, CIRCULAR_SEGMENTS));
    const S = ccw(resample(largestRing(closed), n)).map(([x, y]): Vec2 => [x + off, y]);
    const outline = rotate(S, deg).map(([x, y]): Vec2 => [x + c[0], y + c[1]]);
    return { outline, score: mirrorScore(m, P, c, deg, off), axisDeg: deg, offset: off, centre: c };
  } finally {
    for (const x of live) x.delete();
  }
}
