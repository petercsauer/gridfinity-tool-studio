// 2D pocket geometry in mm: rotation, clearance offset with the finger slot, and the
// bin footprint. Mirrors make_pocket/footprint/rotate in src/gts/geometry.py.
import type { CrossSection, ManifoldToplevel } from 'manifold-3d';
import {
  CIRCULAR_SEGMENTS, FLOOR_MIN, GAP, GRID, HOLE_FLOOR, LIP_INSET, MAGNET_H, MIN_WALL, RECESS, SCREW_H,
  SLOT_FRAC_RANGE, UHT,
} from './constants';

export type Vec2 = [number, number];
export type Ring = Vec2[];

export interface PocketParams {
  clearance: number;
  slotOn: boolean;
  slotR: number;
  slotOver: number;
  slotFrac: number;
}

export interface Pocket {
  /** Outer ring of the tool polygon. */
  tool: Ring;
  /** Outer ring of the pocket: the tool grown by the clearance, plus the finger slot. */
  pocket: Ring;
}

/** Rotate points about the origin by `deg` degrees counter-clockwise. */
export function rotate(P: Ring, deg: number): Ring {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return P.map(([x, y]) => [c * x - s * y, s * x + c * y]);
}

/** Signed shoelace area (positive for counter-clockwise rings). */
export function signedArea(P: Ring): number {
  let a = 0;
  for (let i = 0; i < P.length; i++) {
    const [x0, y0] = P[i]!;
    const [x1, y1] = P[(i + 1) % P.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** The ring in counter-clockwise order. */
export function ccw(P: Ring): Ring {
  return signedArea(P) > 0 ? P : [...P].reverse();
}

export interface Box2 {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

/** One ring or several, as a list of rings. */
export function asRings(P: Ring | readonly Ring[]): Ring[] {
  if (!P.length) return [];
  return Array.isArray(P[0]![0]) ? [...(P as readonly Ring[])] : [P as Ring];
}

export function bounds(P: Ring): Box2 {
  const b = { xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity };
  for (const [x, y] of P) {
    b.xmin = Math.min(b.xmin, x);
    b.ymin = Math.min(b.ymin, y);
    b.xmax = Math.max(b.xmax, x);
    b.ymax = Math.max(b.ymax, y);
  }
  return b;
}

/** Tracks manifold objects so they can all be freed at once. */
class Scope {
  private readonly live: { delete(): void }[] = [];
  keep<T extends { delete(): void }>(x: T): T {
    this.live.push(x);
    return x;
  }
  free(): void {
    for (const x of this.live) x.delete();
    this.live.length = 0;
  }
}

/** The largest connected part of a cross-section (like shapely's largest polygon). */
function largestPart(cs: CrossSection, scope: Scope): CrossSection {
  const parts = cs.decompose().map((p) => scope.keep(p));
  let best: CrossSection | undefined;
  for (const p of parts) if (!best || p.area() > best.area()) best = p;
  if (!best) throw new Error('The outline has no area.');
  return best;
}

/** Outer contour of a single-part cross-section, counter-clockwise. */
function outerRing(cs: CrossSection): Ring {
  let best: Ring = [];
  let bestArea = 0;
  for (const poly of cs.toPolygons()) {
    const ring = poly.map(([x, y]) => [x, y] as Vec2);
    const a = Math.abs(signedArea(ring));
    if (a > bestArea) {
      best = ring;
      bestArea = a;
    }
  }
  return ccw(best);
}

/** Leftmost and rightmost x where the contours cross the horizontal line y = `yy`. */
function crossingsX(contours: readonly (readonly Vec2[])[], yy: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const ring of contours) {
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i]!;
      const [x1, y1] = ring[(i + 1) % ring.length]!;
      if ((y0 - yy) * (y1 - yy) > 0) continue;
      const xs = y0 === y1 ? [x0, x1] : [x0 + ((yy - y0) / (y1 - y0)) * (x1 - x0)];
      for (const x of xs) {
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Tool polygon and pocket polygon: the tool grown by `clearance` (round joins) plus a
 * stadium finger slot across the tool at `slotFrac` of the pocket's height. `slotFrac`
 * is clamped to SLOT_FRAC_RANGE; if the slot line still misses the outline there is no slot. */
export function makePocket(m: ManifoldToplevel, P: Ring, p: PocketParams): Pocket {
  const { CrossSection } = m;
  const scope = new Scope();
  try {
    const tool = largestPart(scope.keep(new CrossSection([P], 'NonZero')), scope);
    let clr = largestPart(
      scope.keep(tool.offset(Math.max(0, p.clearance), 'Round', 2, CIRCULAR_SEGMENTS)), scope);
    if (p.slotOn && p.slotR > 0) {
      const frac = Math.min(Math.max(p.slotFrac, SLOT_FRAC_RANGE[0]), SLOT_FRAC_RANGE[1]);
      const b = clr.bounds();
      const yy = b.min[1] + frac * (b.max[1] - b.min[1]);
      const xs = crossingsX(clr.toPolygons(), yy);
      if (xs) {
        const end = (x: number) =>
          scope.keep(scope.keep(CrossSection.circle(p.slotR, CIRCULAR_SEGMENTS)).translate(x, yy));
        const pill = scope.keep(CrossSection.hull([end(xs[0] - p.slotOver), end(xs[1] + p.slotOver)]));
        clr = largestPart(scope.keep(clr.add(pill)), scope);
      }
    }
    return { tool: outerRing(tool), pocket: outerRing(clr) };
  } finally {
    scope.free();
  }
}

/** Bin footprint [nx, ny] in grid units that holds the pocket with its top round-over:
 * per axis `need = extent + 2*fillet + 2*(LIP_INSET + MIN_WALL) + GAP`, `n = ceil(need / GRID)`.
 * With `halfGrid` the footprint grows in half cells instead (`n = ceil(need / (GRID / 2)) / 2`, so 1.5, 2.5…).
 * Either way the bin's outer size is `GRID * n - GAP`. Several pockets are measured by their combined extent. */
export function footprint(pocket: Ring | readonly Ring[], fillet: number, halfGrid = false): [number, number] {
  const margin = 2 * Math.max(0, fillet) + 2 * (LIP_INSET + MIN_WALL) + GAP;
  const b = bounds(asRings(pocket).flat());
  const cells = (need: number) => (halfGrid ? Math.ceil(need / (GRID / 2)) / 2 : Math.ceil(need / GRID));
  return [cells(b.xmax - b.xmin + margin), cells(b.ymax - b.ymin + margin)];
}

/** Outer size of a bin `n` grid units wide (mm). */
export function binSize(n: number): number {
  return GRID * n - GAP;
}

/** Holes in the bin's base: none, magnets, M3 screws, or a magnet pocket with a screw hole through it. */
export type HoleStyle = 'none' | 'magnet' | 'screw' | 'both';

/** The bin options that change how deep a pocket can go. */
export interface BaseOptions {
  /** Base holes (default none). */
  holes?: HoleStyle;
  /** Stacking lip on top (default on); without it the pocket opens at the bin top. */
  lip?: boolean;
  /** Half-grid feet (default off): they are too small for base holes, so `holes` is ignored. */
  halfGrid?: boolean;
}

/** The base holes actually cut: none with half-grid feet. */
export function baseHoles(o: BaseOptions = {}): HoleStyle {
  return o.halfGrid ? 'none' : o.holes ?? 'none';
}

/** Depth below the bin top at which the pocket opens: the lip trough floor, or the top without a lip. */
export function recess(o: BaseOptions = {}): number {
  return o.lip === false ? 0 : RECESS;
}

/** Lowest pocket floor: above the feet, and above the deepest base hole so the pocket can't break into it. */
export function floorMin(o: BaseOptions = {}): number {
  const holes = baseHoles(o);
  const hole = holes === 'none' ? 0 : holes === 'magnet' ? MAGNET_H : SCREW_H;
  return Math.max(FLOOR_MIN, hole + HOLE_FLOOR);
}

/** Deepest pocket a `u`-unit bin can hold, measured from the pocket opening (0 at 1U with the lip). */
export function maxDepth(u: number, o: BaseOptions = {}): number {
  return Math.max(0, u * UHT - recess(o) - floorMin(o));
}

/** The pocket depth actually cut for a requested depth at height `u`. */
export function effectiveDepth(u: number, depth: number, o: BaseOptions = {}): number {
  return Math.max(0, Math.min(depth, maxDepth(u, o)));
}
