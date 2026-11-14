// Bin parameters, their allowed ranges (the inspector's slider ranges) and clamping.
import { maxDepth, type HoleStyle } from './geometry/pocket';

/** The per-part fields (sym, clearance, rot, the slot and depth) are what a kit's parts start with when it
 * has no layout yet (kit.ts initialLayout); a layout's placements carry their own. `rot` only turns a one-part
 * kit's initial layout (0-90°); the inspector turns a placed part through -180…180° in its layout. */
export interface Params {
  tool: string;
  sym: boolean;
  clearance: number;
  rot: number;
  slotOn: boolean;
  slotR: number;
  slotOver: number;
  slotFrac: number;
  u: number;
  depth: number;
  fillet: number;
  bfillet: number;
  /** Base holes, whether only the bin's outer corners get them, and the stacking lip. */
  holes: HoleStyle;
  holesCorners: boolean;
  lip: boolean;
  /** Feet on a 21 mm half-grid, so the footprint grows in half cells (no base holes then). */
  halfGrid: boolean;
}

export const HOLE_STYLES: readonly HoleStyle[] = ['none', 'magnet', 'screw', 'both'];

type NumericKey = { [K in keyof Params]: Params[K] extends number ? K : never }[keyof Params];

export const DEFAULTS: Params = {
  tool: 'groovejoint', sym: false, clearance: 2.5, rot: 0, slotOn: true, slotR: 12.5, slotOver: 6,
  slotFrac: 0.4, u: 3, depth: 10, fillet: 3.175, bfillet: 0, holes: 'none', holesCorners: false, lip: true,
  halfGrid: false,
};

/** Allowed [min, max] of every numeric parameter. */
export const RANGES: Record<NumericKey, readonly [number, number]> = {
  clearance: [0, 5],
  rot: [0, 90],
  slotR: [4, 20],
  slotOver: [0, 20],
  slotFrac: [0, 1],
  u: [1, 8], // keep in sync with the depth range below
  depth: [0, maxDepth(8, { lip: false })], // the Depth slider is capped further per height (maxDepth(u, options))
  fillet: [0, 6],
  bfillet: [0, 4],
};

/** Largest bin footprint, in grid cells per axis (8 whole cells, or 16 half cells with half-grid feet). */
export const MAX_CELLS = 8;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Parameters with every number finite and inside its range (non-numbers fall back to the
 * default), the height a whole number of units, the booleans coerced, and an unknown hole style
 * (or a missing option, from an older caller) replaced by the default. */
export function clampParams(p: Params): Params {
  const out: Params = {
    ...p, tool: String(p.tool), sym: !!p.sym, slotOn: !!p.slotOn,
    holes: HOLE_STYLES.includes(p.holes) ? p.holes : DEFAULTS.holes,
    holesCorners: !!p.holesCorners,
    lip: p.lip === undefined ? DEFAULTS.lip : !!p.lip,
    halfGrid: !!p.halfGrid,
  };
  for (const key of Object.keys(RANGES) as NumericKey[]) {
    const [lo, hi] = RANGES[key];
    const v = Number(p[key]);
    out[key] = Number.isFinite(v) ? clamp(v, lo, hi) : DEFAULTS[key];
  }
  out.u = Math.round(out.u);
  return out;
}
