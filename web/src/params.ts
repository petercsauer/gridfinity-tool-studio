// Bin parameters, their allowed ranges (the inspector's slider ranges) and clamping.
import { maxDepth } from './geometry/pocket';

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
}

type NumericKey = { [K in keyof Params]: Params[K] extends number ? K : never }[keyof Params];

export const DEFAULTS: Params = {
  tool: 'needlenose', sym: true, clearance: 2.5, rot: 0, slotOn: true, slotR: 12.5, slotOver: 6,
  slotFrac: 0.4, u: 3, depth: 10, fillet: 3.175, bfillet: 0,
};

/** Allowed [min, max] of every numeric parameter. */
export const RANGES: Record<NumericKey, readonly [number, number]> = {
  clearance: [0, 5],
  rot: [0, 90],
  slotR: [4, 20],
  slotOver: [0, 20],
  slotFrac: [0, 1],
  u: [1, 8], // keep in sync with the depth range below
  depth: [0, maxDepth(8)], // the Depth slider is capped further per height (maxDepth(u))
  fillet: [0, 6],
  bfillet: [0, 4],
};

/** Largest bin footprint, in grid cells per axis. */
export const MAX_CELLS = 8;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Parameters with every number finite and inside its range (non-numbers fall back to the
 * default), the height a whole number of units, and the booleans coerced. */
export function clampParams(p: Params): Params {
  const out: Params = { ...p, tool: String(p.tool), sym: !!p.sym, slotOn: !!p.slotOn };
  for (const key of Object.keys(RANGES) as NumericKey[]) {
    const [lo, hi] = RANGES[key];
    const v = Number(p[key]);
    out[key] = Number.isFinite(v) ? clamp(v, lo, hi) : DEFAULTS[key];
  }
  out.u = Math.round(out.u);
  return out;
}
