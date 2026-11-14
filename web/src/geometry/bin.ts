// Watertight gridfinity bin with a tool pocket, built with manifold-3d.
// Mirrors genbin in src/gts/bin.py (kennetek standard.scad dimensions).
import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';
import { GAP, GRID, HOLE_FROM_SIDE, MAGNET_D, MAGNET_H, SCREW_D, SCREW_H, UHT } from './constants';
import { asRings, baseHoles, ccw, floorMin, recess, signedArea, type HoleStyle, type Ring, type Vec2 } from './pocket';

/** Top radius of the outer wall and the foot pads (bottom, middle, top sizes and radii). The pad sizes are
 * for a 42 mm cell; a foot on a pitch of `p` mm is `GRID - p` smaller (20.5, 16.2 and 14.6 for 21 mm). */
const R_TOP = 3.75;
const PAD_BOT = 35.6;
const R_BOT = 0.8;
const PAD_MID = 37.2;
const R_MID = 1.6;
const PAD_TOP = 41.5;
/** Foot pitch with half-grid feet. */
const HALF = GRID / 2;
/** Stacking-lip trough: rim and lead-in widths. */
const RIM = 1.8;
const LEAD = 1.4;
/** Layers in each stepped round-over, and segments per circle for its offsets (shapely quad_segs=24). */
const STEPS = 16;
const ROUND_SEGMENTS = 96;
/** Each round-over layer is simplified to this (mm) before it is extruded. */
const LAYER_TOL = 0.02;
/** Segments per circle of the rounded-rectangle corners and the base holes. */
const RECT_SEGMENTS = 48;
const HOLE_SEGMENTS = 48;
/** Vertices closer than this (mm) are merged in the final mesh, as in the Python reference. */
const SIMPLIFY_TOL = 1e-3;

export interface BinParams {
  /** Height in 7 mm units. */
  u: number;
  /** Requested pocket depth below the pocket opening (mm), for pockets given without their own. */
  depth: number;
  /** Top round-over and bottom round radii (mm). */
  fillet: number;
  bfillet: number;
  /** Holes in the base (default none) and whether only the bin's four outer corners get them. */
  holes?: HoleStyle;
  holesCorners?: boolean;
  /** Stacking lip on top (default on). */
  lip?: boolean;
  /** One foot per 21 mm half cell (default off): `nx`/`ny` may then be x.5, and no holes are cut. */
  halfGrid?: boolean;
}

export interface BinMesh {
  /** xyz per vertex (mm, Z up) and three vertex indices per triangle. */
  positions: Float32Array;
  indices: Uint32Array;
  /** The pocket depth actually cut (less than requested when the bin is too low): the deepest, and each
   * cut's in order. */
  effectiveDepth: number;
  effectiveDepths: number[];
  nx: number;
  ny: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  volume: number;
}

type Disposable = { delete(): void };

let live = 0;

/** Manifold objects made by genbin that have not been freed yet (0 between builds). */
export function liveObjects(): number {
  return live;
}

/** Tracks the manifold objects of one build so they are all freed at the end. */
class Scope {
  private readonly items: Disposable[] = [];
  keep<T extends Disposable>(x: T): T {
    this.items.push(x);
    live++;
    return x;
  }
  free(): void {
    for (const x of this.items) x.delete();
    live -= this.items.length;
    this.items.length = 0;
  }
}

/** A pocket and its own depth below the pocket opening (mm). */
export interface PocketCut {
  ring: Ring;
  depth: number;
}

/** Pockets as given to genbin: one ring or several (all at `p.depth`), or cuts with their own depths. */
export type Pockets = Ring | readonly Ring[] | readonly PocketCut[];

/** The pockets as cuts, rings getting `depth`. */
function asCuts(pockets: Pockets, depth: number): PocketCut[] {
  const first = pockets[0];
  if (first && 'ring' in first) return [...(pockets as readonly PocketCut[])];
  return asRings(pockets as Ring | readonly Ring[]).map((ring) => ({ ring, depth }));
}

/** The bin as a manifold, the deepest depth cut and each cut's depth (in `pockets` order). The caller owns
 * (and must delete) the manifold. */
export function genbinManifold(
  m: ManifoldToplevel, pockets: Pockets, nx: number, ny: number, p: BinParams,
): { bin: Manifold; effectiveDepth: number; effectiveDepths: number[] } {
  const { CrossSection, Manifold } = m;
  const s = new Scope();
  try {
    /** Rounded rectangle centred at the origin. */
    const rr = (w: number, h: number, r0: number): CrossSection => {
      const r = Math.max(0.2, Math.min(r0, w / 2 - 0.05, h / 2 - 0.05));
      const sq = s.keep(new CrossSection([[[-w / 2 + r, -h / 2 + r], [w / 2 - r, -h / 2 + r],
        [w / 2 - r, h / 2 - r], [-w / 2 + r, h / 2 - r]]], 'Positive'));
      return s.keep(sq.offset(r, 'Round', 2, RECT_SEGMENTS));
    };
    const slab = (cs: CrossSection, z0: number, z1: number): Manifold =>
      s.keep(s.keep(cs.extrude(z1 - z0)).translate([0, 0, z0]));
    const frustum = (a: number, ra: number, z0: number, b: number, rb: number, z1: number): Manifold =>
      s.keep(Manifold.hull([slab(rr(a, a, ra), z0, z0 + 0.02), slab(rr(b, b, rb), z1 - 0.02, z1)]));

    const pitch = p.halfGrid ? HALF : GRID;
    const fx = Math.round((nx * GRID) / pitch);
    const fy = Math.round((ny * GRID) / pitch);
    if (Math.abs(fx * pitch - nx * GRID) > 1e-9 || Math.abs(fy * pitch - ny * GRID) > 1e-9 || fx < 1 || fy < 1) {
      throw new Error(`A ${nx}×${ny} bin needs ${p.halfGrid ? 'whole or half' : 'whole'} grid cells.`);
    }
    const top = p.u * UHT;
    const Dx = GRID * nx - GAP;
    const Dy = GRID * ny - GAP;
    const recessZ = top - recess(p); // the pocket opens at the lip trough floor (or the top, lip off)

    // same vertical profile and radii at any pitch; only the pad sizes shrink with it
    const shrink = GRID - pitch;
    const bot = PAD_BOT - shrink, mid = PAD_MID - shrink, padTop = PAD_TOP - shrink;
    const foot = s.keep(Manifold.union([
      frustum(bot, R_BOT, 0, mid, R_MID, 0.8),
      slab(rr(mid, mid, R_MID), 0.8, 2.6),
      frustum(mid, R_MID, 2.6, padTop, R_TOP, 4.75),
    ]));
    const parts: Manifold[] = [slab(rr(Dx, Dy, R_TOP), 4.75, top)];
    for (let i = 0; i < fx; i++) {
      for (let j = 0; j < fy; j++) {
        parts.push(s.keep(foot.translate([(i + 0.5) * pitch - (pitch * fx) / 2, (j + 0.5) * pitch - (pitch * fy) / 2, 0])));
      }
    }
    const solid = s.keep(Manifold.union(parts));
    // stacking lip: chamfered perimeter trough
    const lip = p.lip === false ? null : s.keep(Manifold.hull([
      slab(rr(Dx - 2 * RIM - 2 * LEAD, Dy - 2 * RIM - 2 * LEAD, Math.max(0.3, R_TOP - RIM - LEAD)), top - 4.4, top - 4.38),
      slab(rr(Dx - 2 * RIM, Dy - 2 * RIM, Math.max(0.3, R_TOP - RIM)), top - 3, top + 1),
    ]));
    // base holes, open at the bottom of each foot: a magnet pocket and/or a screw hole per cell corner
    // (none with half-grid feet: the 8 mm-from-side positions don't fit on their 20.5 mm pads)
    const holes = baseHoles(p);
    const holeCutters: Manifold[] = [];
    if (holes !== 'none') {
      const cyl = (d: number, h: number) => s.keep(s.keep(Manifold.cylinder(h + 0.01, d / 2, d / 2, HOLE_SEGMENTS)).translate([0, 0, -0.01]));
      const shapes: Manifold[] = [];
      if (holes === 'magnet' || holes === 'both') shapes.push(cyl(MAGNET_D, MAGNET_H));
      if (holes === 'screw' || holes === 'both') shapes.push(cyl(SCREW_D, SCREW_H));
      const hole = shapes.length === 1 ? shapes[0]! : s.keep(Manifold.union(shapes));
      const o = GRID / 2 - HOLE_FROM_SIDE;
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
          const cx = (i + 0.5) * GRID - (GRID * nx) / 2, cy = (j + 0.5) * GRID - (GRID * ny) / 2;
          for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
            // corners only: the hole nearest each of the bin's four outer corners
            if (p.holesCorners && !((sx < 0 ? i === 0 : i === nx - 1) && (sy < 0 ? j === 0 : j === ny - 1))) continue;
            holeCutters.push(s.keep(hole.translate([cx + sx * o, cy + sy * o, 0])));
          }
        }
      }
    }

    // tool pockets, with round-overs that follow the actual outline (stepped offset layers,
    // no convex hull: a hull would fill the concave jaw/handle gaps); pockets that overlap at the
    // same floor are one pocket, and where floors differ the deeper one wins
    /** Offset of the circular round-over profile at fraction `i/STEPS` of radius `f`. */
    const law = (f: number, i: number) => {
      const d = (i / STEPS) * f;
      return f - Math.sqrt(Math.max(0, f * f - (f - d) ** 2));
    };
    const cutters: Manifold[] = [];
    /** Cutters for the pockets `rings` with their floor at `floorTop`, one per pocket: a slab down to the floor
     * and its round-over layers. */
    const pocketCutters = (rings: Ring[], floorTop: number): void => {
      const ft = Math.max(0, Math.min(p.fillet, recessZ - floorTop - 0.5)); // top: convex, flares out
      const fb = Math.max(0, Math.min(p.bfillet, recessZ - floorTop - 0.5)); // bottom: concave, insets in
      for (const pk of s.keep(new CrossSection(rings, 'Positive')).decompose()) {
        s.keep(pk);
        const own: Manifold[] = [slab(pk, floorTop + fb, top + 1)];
        /** A layer of the pocket offset by `delta` (largest part, outer contour only) from za to zb. */
        const ring = (delta: number, za: number, zb: number): void => {
          // simplified to 0.02 mm: a quarter of the time and half the triangles, no visible change
          const off = s.keep(s.keep(pk.offset(delta, 'Round', 2, ROUND_SEGMENTS)).simplify(LAYER_TOL));
          let best: CrossSection | undefined;
          for (const part of off.decompose()) {
            s.keep(part);
            if (!best || part.area() > best.area()) best = part;
          }
          if (!best || best.area() < 1) return;
          const outer = s.keep(new CrossSection([outerContour(best)], 'Positive'));
          own.push(slab(outer, za, zb));
        };
        if (ft > 0.05) {
          for (let i = 0; i < STEPS; i++) {
            const off = law(ft, i);
            if (off < 1e-3) continue;
            ring(off, recessZ - ((i + 1) / STEPS) * ft - 0.01, recessZ - (i / STEPS) * ft + 0.01);
          }
        }
        if (fb > 0.05) {
          for (let i = 0; i < STEPS; i++) {
            ring(-law(fb, i), floorTop + (i / STEPS) * fb - 0.01, floorTop + ((i + 1) / STEPS) * fb + 0.01);
          }
        }
        cutters.push(s.keep(Manifold.union(own)));
      }
    };
    const floorOf = (depth: number) => Math.max(floorMin(p), recessZ - depth);
    const cuts = asCuts(pockets, p.depth).map((c) => ({ ring: ccw(c.ring), floorTop: floorOf(c.depth) }));
    // pockets with the same floor are cut together, so overlapping ones get one round-over
    for (const f of new Set(cuts.map((c) => c.floorTop))) {
      pocketCutters(cuts.filter((c) => c.floorTop === f).map((c) => c.ring), f);
    }
    const shell = lip ? s.keep(solid.subtract(lip)) : solid;
    let raw: Manifold;
    if (cutters.length === 1) {
      // one pocket: holes and pocket unioned, then subtracted, as the single-pocket bin always was (same mesh)
      const cut = holeCutters.length ? s.keep(Manifold.union([cutters[0]!, ...holeCutters])) : cutters[0]!;
      raw = s.keep(shell.subtract(cut));
    } else {
      // several: one batch difference (BatchBoolean) of the pockets' own cutters and the holes
      raw = s.keep(Manifold.difference([shell, ...cutters, ...holeCutters]));
    }
    // merge near-coincident vertices left where the stepped round-over layers meet; without
    // this, STL readers that weld vertices by position see zero-volume slivers
    const bin = raw.simplify(SIMPLIFY_TOL);
    const effectiveDepths = cuts.map((c) => Math.max(0, recessZ - c.floorTop));
    const effectiveDepth = cuts.length ? Math.max(...effectiveDepths) : Math.max(0, recessZ - floorOf(p.depth));
    return { bin, effectiveDepth, effectiveDepths };
  } finally {
    s.free();
  }
}

/** Largest contour of a cross-section, counter-clockwise. */
function outerContour(cs: CrossSection): Vec2[] {
  let best: Vec2[] = [];
  let bestArea = 0;
  for (const poly of cs.toPolygons()) {
    const r = poly.map(([x, y]) => [x, y] as Vec2);
    const a = Math.abs(signedArea(r));
    if (a > bestArea) {
      best = r;
      bestArea = a;
    }
  }
  return ccw(best);
}

/** Build an `nx` x `ny` cell, `u`-unit bin with `pockets` (mm, centred on the origin) cut below the stacking-lip
 * recess, as triangle arrays. Each depth is limited to maxDepth(u, p). */
export function genbin(m: ManifoldToplevel, pockets: Pockets, nx: number, ny: number, p: BinParams): BinMesh {
  const { bin, effectiveDepth, effectiveDepths } = genbinManifold(m, pockets, nx, ny, p);
  try {
    const mesh = bin.getMesh();
    const np = mesh.numProp;
    const nv = mesh.vertProperties.length / np;
    const positions = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      positions[v * 3] = mesh.vertProperties[v * np]!;
      positions[v * 3 + 1] = mesh.vertProperties[v * np + 1]!;
      positions[v * 3 + 2] = mesh.vertProperties[v * np + 2]!;
    }
    const box = bin.boundingBox();
    return {
      positions,
      indices: Uint32Array.from(mesh.triVerts),
      effectiveDepth,
      effectiveDepths,
      nx,
      ny,
      bbox: { min: [box.min[0], box.min[1], box.min[2]], max: [box.max[0], box.max[1], box.max[2]] },
      volume: bin.volume(),
    };
  } finally {
    bin.delete();
  }
}
