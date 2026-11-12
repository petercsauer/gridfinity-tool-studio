// Watertight gridfinity bin with a tool pocket, built with manifold-3d.
// Mirrors genbin in src/gts/bin.py (kennetek standard.scad dimensions).
import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';
import { FLOOR_MIN, GAP, GRID, RECESS, UHT } from './constants';
import { ccw, signedArea, type Ring, type Vec2 } from './pocket';

/** Top radius of the outer wall and the foot pads (bottom, middle, top sizes and radii). */
const R_TOP = 3.75;
const PAD_BOT = 35.6;
const R_BOT = 0.8;
const PAD_MID = 37.2;
const R_MID = 1.6;
const PAD_TOP = 41.5;
/** Stacking-lip trough: rim and lead-in widths. */
const RIM = 1.8;
const LEAD = 1.4;
/** Layers in each stepped round-over, and segments per circle for its offsets (shapely quad_segs=24). */
const STEPS = 16;
const ROUND_SEGMENTS = 96;
/** Segments per circle of the rounded-rectangle corners. */
const RECT_SEGMENTS = 48;
/** Vertices closer than this (mm) are merged in the final mesh, as in the Python reference. */
const SIMPLIFY_TOL = 1e-3;

export interface BinParams {
  /** Height in 7 mm units. */
  u: number;
  /** Requested pocket depth below the pocket opening (mm). */
  depth: number;
  /** Top round-over and bottom round radii (mm). */
  fillet: number;
  bfillet: number;
}

export interface BinMesh {
  /** xyz per vertex (mm, Z up) and three vertex indices per triangle. */
  positions: Float32Array;
  indices: Uint32Array;
  /** The pocket depth actually cut (less than requested when the bin is too low). */
  effectiveDepth: number;
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

/** The bin as a manifold, and the depth cut. The caller owns (and must delete) the manifold. */
export function genbinManifold(
  m: ManifoldToplevel, pocket: Ring, nx: number, ny: number, p: BinParams,
): { bin: Manifold; effectiveDepth: number } {
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

    const top = p.u * UHT;
    const Dx = GRID * nx - GAP;
    const Dy = GRID * ny - GAP;
    const recessZ = top - RECESS; // the pocket opens at the lip trough floor
    const floorTop = Math.max(FLOOR_MIN, recessZ - p.depth);

    const foot = s.keep(Manifold.union([
      frustum(PAD_BOT, R_BOT, 0, PAD_MID, R_MID, 0.8),
      slab(rr(PAD_MID, PAD_MID, R_MID), 0.8, 2.6),
      frustum(PAD_MID, R_MID, 2.6, PAD_TOP, R_TOP, 4.75),
    ]));
    const parts: Manifold[] = [slab(rr(Dx, Dy, R_TOP), 4.75, top)];
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        parts.push(s.keep(foot.translate([(i + 0.5) * GRID - (GRID * nx) / 2, (j + 0.5) * GRID - (GRID * ny) / 2, 0])));
      }
    }
    const solid = s.keep(Manifold.union(parts));
    // stacking lip: chamfered perimeter trough
    const lip = s.keep(Manifold.hull([
      slab(rr(Dx - 2 * RIM - 2 * LEAD, Dy - 2 * RIM - 2 * LEAD, Math.max(0.3, R_TOP - RIM - LEAD)), top - 4.4, top - 4.38),
      slab(rr(Dx - 2 * RIM, Dy - 2 * RIM, Math.max(0.3, R_TOP - RIM)), top - 3, top + 1),
    ]));

    // tool pocket, with round-overs that follow the actual outline (stepped offset layers,
    // no convex hull: a hull would fill the concave jaw/handle gaps)
    const pk = s.keep(new CrossSection([ccw(pocket)], 'Positive'));
    const ft = Math.max(0, Math.min(p.fillet, recessZ - floorTop - 0.5)); // top: convex, flares out
    const fb = Math.max(0, Math.min(p.bfillet, recessZ - floorTop - 0.5)); // bottom: concave, insets in
    const cutters: Manifold[] = [slab(pk, floorTop + fb, top + 1)];
    /** A layer of the pocket offset by `delta` (largest part, outer contour only) from za to zb. */
    const ring = (delta: number, za: number, zb: number): void => {
      const off = s.keep(pk.offset(delta, 'Round', 2, ROUND_SEGMENTS));
      let best: CrossSection | undefined;
      for (const part of off.decompose()) {
        s.keep(part);
        if (!best || part.area() > best.area()) best = part;
      }
      if (!best || best.area() < 1) return;
      const outer = s.keep(new CrossSection([outerContour(best)], 'Positive'));
      cutters.push(slab(outer, za, zb));
    };
    /** Offset of the circular round-over profile at fraction `i/STEPS` of radius `f`. */
    const law = (f: number, i: number) => {
      const d = (i / STEPS) * f;
      return f - Math.sqrt(Math.max(0, f * f - (f - d) ** 2));
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
    const cutter = s.keep(Manifold.union(cutters));
    const shell = s.keep(solid.subtract(lip));
    const raw = s.keep(shell.subtract(cutter));
    // merge near-coincident vertices left where the stepped round-over layers meet; without
    // this, STL readers that weld vertices by position see zero-volume slivers
    const bin = raw.simplify(SIMPLIFY_TOL);
    return { bin, effectiveDepth: Math.max(0, recessZ - floorTop) };
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

/** Build an `nx` x `ny` cell, `u`-unit bin with `pocket` (mm, centred on the origin) cut below
 * the stacking-lip recess, as triangle arrays. The depth is limited to maxDepth(u). */
export function genbin(m: ManifoldToplevel, pocket: Ring, nx: number, ny: number, p: BinParams): BinMesh {
  const { bin, effectiveDepth } = genbinManifold(m, pocket, nx, ny, p);
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
      nx,
      ny,
      bbox: { min: [box.min[0], box.min[1], box.min[2]], max: [box.max[0], box.max[1], box.max[2]] },
      volume: bin.volume(),
    };
  } finally {
    bin.delete();
  }
}
