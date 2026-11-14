// Arrange: pack a kit's parts into the fewest grid cells. Each part is tried upright (its snap axis along y) and
// on its side, the pockets' boxes are packed in rows, left to right, for every bin width that could hold them,
// and the arrangement needing the fewest cells wins (then the squarest, then the smallest area). Parts are kept
// far enough apart that their walls aren't flagged as thin.
import { bounds, footprint, rotate, type Ring } from './geometry/pocket';
import { MIN_WALL } from './geometry/constants';
import { MAX_CELLS } from './params';

export interface PackPart {
  id: string;
  /** The pocket in the part frame (mm). */
  pocket: Ring;
  /** The angle of the axis the part snaps by, from the part frame's y axis (degrees). */
  axisDeg: number;
}

export interface Packed {
  /** Where each part goes (bin mm, centred on the origin) and its rotation. */
  placements: { part: string; x: number; y: number; rot: number }[];
  nx: number;
  ny: number;
}

/** Most parts tried in every orientation (2^n combinations); more get each part's narrower side across. */
const EXHAUSTIVE = 10;

interface Item {
  id: string;
  rot: number;
  w: number;
  h: number;
  /** Centre of the rotated pocket's box, to place the part by its box. */
  cx: number;
  cy: number;
}

/** The part turned so its axis runs along y (`side` false) or along x, and its pocket's box then. */
function orient(p: PackPart, side: boolean): Item {
  const rot = -p.axisDeg + (side ? 90 : 0);
  const b = bounds(rotate(p.pocket, rot));
  return { id: p.id, rot, w: b.xmax - b.xmin, h: b.ymax - b.ymin, cx: (b.xmin + b.xmax) / 2, cy: (b.ymin + b.ymax) / 2 };
}

/** Pack boxes in rows no wider than `maxW`, tallest first; the boxes' positions (lower-left) and the extent. */
function shelves(items: Item[], maxW: number, gap: number): { at: [number, number][]; w: number; h: number } | null {
  const order = items.map((_, k) => k).sort((a, b) => items[b]!.h - items[a]!.h || items[b]!.w - items[a]!.w);
  const at: [number, number][] = new Array(items.length);
  let x = 0, y = 0, rowH = 0, w = 0;
  for (const k of order) {
    const it = items[k]!;
    if (it.w > maxW + 1e-9) return null;
    if (x > 0 && x + it.w > maxW + 1e-9) {
      y += rowH + gap;
      x = 0;
      rowH = 0;
    }
    at[k] = [x, y];
    x += it.w + gap;
    rowH = Math.max(rowH, it.h);
    w = Math.max(w, x - gap);
  }
  return { at, w, h: y + rowH };
}

/** The best packing of `parts`, with at least `gap` mm between pockets, for a bin with top round-over `fillet`. */
export function arrange(parts: readonly PackPart[], { gap, fillet, halfGrid }: { gap: number; fillet: number; halfGrid: boolean }): Packed {
  const n = parts.length;
  const combos: boolean[][] = [];
  if (n <= EXHAUSTIVE) {
    for (let m = 0; m < 1 << n; m++) combos.push(parts.map((_, k) => !!(m & (1 << k))));
  } else {
    // each part with its narrower side across, then all upright, then all on their side
    combos.push(parts.map((p) => orient(p, false).w > orient(p, true).w));
    combos.push(parts.map(() => false), parts.map(() => true));
  }
  const cells = (extent: number) => {
    const [c] = footprint([[0, 0], [extent, 0], [extent, 1], [0, 1]], fillet, halfGrid);
    return c;
  };
  const step = halfGrid ? 0.5 : 1;
  let best: { score: [number, number, number]; items: Item[]; at: [number, number][]; w: number; h: number } | null = null;
  for (const sides of combos) {
    const items = parts.map((p, k) => orient(p, sides[k]!));
    // every row width a bin from one cell up to the largest could hold, and one row of everything
    const widths = new Set<number>([Infinity]);
    for (let c = step; c <= MAX_CELLS + 1e-9; c += step) {
      // the widest pocket extent a c-cell bin holds (footprint's margin taken off)
      let lo = 0, hi = c * 42;
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2;
        if (cells(mid) <= c) lo = mid;
        else hi = mid;
      }
      widths.add(lo);
    }
    for (const maxW of widths) {
      const r = shelves(items, maxW, gap);
      if (!r) continue;
      const nx = cells(r.w), ny = cells(r.h);
      const score: [number, number, number] = [nx * ny, Math.max(nx, ny), r.w * r.h];
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && (score[1] < best.score[1]
        || (score[1] === best.score[1] && score[2] < best.score[2] - 1e-6)))) {
        best = { score, items, ...r };
      }
    }
  }
  const b = best!;
  // centre the arrangement on the origin
  const ox = -b.w / 2, oy = -b.h / 2;
  return {
    placements: b.items.map((it, k) => {
      const [x, y] = b.at[k]!;
      // the rotated pocket's box centre goes to the box's slot: x = slot centre - box centre
      return { part: it.id, x: ox + x + it.w / 2 - it.cx, y: oy + y + it.h / 2 - it.cy, rot: it.rot };
    }),
    nx: cells(b.w),
    ny: cells(b.h),
  };
}

/** The gap between pockets that the thin-wall warning allows: the least wall plus both pockets' round-overs. */
export const packGap = (fillet: number) => MIN_WALL + 2 * Math.max(0, fillet) + 0.2;
