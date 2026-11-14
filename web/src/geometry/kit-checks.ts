// Layout checks for a kit's placed pockets: pockets that overlap (they merge into one), walls between pockets
// thinner than the minimum once their round-overs are cut, and pockets outside a locked bin's usable area.
import type { CrossSection, ManifoldToplevel } from 'manifold-3d';
import { LIP_INSET, MIN_WALL } from './constants';
import { binSize, bounds, ccw, type Box2, type Ring } from './pocket';

/** `overlap` and `thin-wall` name the two parts; `outside` names one. */
export interface LayoutWarning {
  kind: 'overlap' | 'thin-wall' | 'outside';
  parts: [string, string?];
}

/** A pocket placed in the bin (mm, bin coordinates) and the id of its part. */
export interface PlacedPocket {
  id: string;
  ring: Ring;
}

/** Intersections smaller than this (mm²) are taken as touching, not overlapping. */
const OVERLAP_AREA = 0.5;
/** Grown pockets meeting by less than this (mm²) leave a wall of just the minimum. */
const WALL_AREA = 1e-3;

const apart = (a: Box2, b: Box2, d: number) =>
  a.xmin > b.xmax + d || b.xmin > a.xmax + d || a.ymin > b.ymax + d || b.ymin > a.ymax + d;

/** Warnings for `pockets`: each pair that overlaps, else each pair closer than MIN_WALL plus both top
 * round-overs (`fillet`); with a locked bin of `cells`, each pocket not inside the area a pocket may use
 * (the bin less the lip, the minimum wall and the round-over on every side; the bin is centred on the origin). */
export function checkLayout(
  m: ManifoldToplevel, pockets: readonly PlacedPocket[], p: { fillet: number }, cells?: readonly [number, number],
): LayoutWarning[] {
  const { CrossSection } = m;
  const live: CrossSection[] = [];
  const keep = (cs: CrossSection) => {
    live.push(cs);
    return cs;
  };
  try {
    const fillet = Math.max(0, p.fillet);
    const grow = (MIN_WALL + 2 * fillet) / 2;
    const shapes = pockets.map((q) => keep(new CrossSection([ccw(q.ring)], 'Positive')));
    const grown = shapes.map((cs) => keep(cs.offset(grow, 'Round', 2, 32)));
    const boxes = pockets.map((q) => bounds(q.ring));
    const out: LayoutWarning[] = [];
    for (let i = 0; i < pockets.length; i++) {
      for (let j = i + 1; j < pockets.length; j++) {
        if (apart(boxes[i]!, boxes[j]!, 2 * grow)) continue;
        const parts: [string, string] = [pockets[i]!.id, pockets[j]!.id];
        if (keep(shapes[i]!.intersect(shapes[j]!)).area() > OVERLAP_AREA) out.push({ kind: 'overlap', parts });
        else if (keep(grown[i]!.intersect(grown[j]!)).area() > WALL_AREA) out.push({ kind: 'thin-wall', parts });
      }
    }
    if (cells) {
      const margin = 2 * (LIP_INSET + MIN_WALL + fillet);
      const w = binSize(cells[0]) - margin;
      const h = binSize(cells[1]) - margin;
      const usable = keep(CrossSection.square([Math.max(0, w), Math.max(0, h)], true));
      pockets.forEach((q, i) => {
        if (keep(shapes[i]!.subtract(usable)).area() > OVERLAP_AREA) out.push({ kind: 'outside', parts: [q.id] });
      });
    }
    return out;
  } finally {
    for (const cs of live) cs.delete();
  }
}
