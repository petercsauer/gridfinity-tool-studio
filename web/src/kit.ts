// Kits: the parts traced from one photo and how they are laid out in one bin. A part keeps the geometry from
// the photo; a placement puts it in the bin (position and angle) with its own pocket settings. Presets and
// single-tool uploads are one-part kits whose part sits unmoved at the origin, which builds exactly the bin
// a single tool always did.
import { clamp, clampParams, type Params } from './params';
import { rotate, type Ring, type Vec2 } from './geometry/pocket';
import type { Affine } from './vision/outline';

/** A part's symmetric outline and its mirror axis (through `centre`, `axisDeg` from the y axis, shifted
 * sideways by `offset`), all in the part's upright frame. */
export interface PartSymmetry {
  outline: Ring;
  /** Mirror IoU of the outline about the axis; 1 for a perfectly symmetric part. */
  score: number;
  axisDeg: number;
  offset: number;
  centre: Vec2;
}

/** One traced part: its upright, centred outline (mm) and where it lay on the sheet. */
export interface Part {
  id: string;
  outline: Ring;
  /** Size [w, h] of the upright crop the outline is centred in (mm). */
  crop: [number, number];
  /** 2x3 affine [A | b] from the part's outline mm to sheet mm. */
  up2sheet: Affine;
  symmetry: PartSymmetry;
}

/** The pocket settings each part has for itself. */
export interface PartSettings {
  sym: boolean;
  clearance: number;
  slotOn: boolean;
  slotR: number;
  slotOver: number;
  slotFrac: number;
  depth: number;
}

/** A part in the bin: turned by `rot` degrees counter-clockwise about its outline origin, then moved to
 * (`x`, `y`) mm. Hidden parts stay in the layout but get no pocket. */
export interface Placement extends PartSettings {
  part: string;
  x: number;
  y: number;
  rot: number;
  hidden?: boolean;
}

export interface Layout {
  placements: Placement[];
  /** A locked bin size [nx, ny] in grid cells; without it the bin grows to fit the parts. */
  cells?: [number, number];
}

/** Below this mirror IoU a part's axis is too unreliable to snap to; its upright (long) axis is used instead. */
export const AXIS_SCORE = 0.8;

/** The pocket settings in `params`, as a part's own. */
export function settingsFromParams(p: Params): PartSettings {
  return {
    sym: p.sym, clearance: p.clearance, slotOn: p.slotOn, slotR: p.slotR, slotOver: p.slotOver,
    slotFrac: p.slotFrac, depth: p.depth,
  };
}

/** Rotation (degrees) of a 2x3 rigid affine's linear part. */
export function affineAngle(M: Affine): number {
  return (Math.atan2(M[1][0], M[0][0]) * 180) / Math.PI;
}

/** An angle in degrees folded into (-180, 180]. */
export function normalizeDeg(deg: number): number {
  const r = ((deg % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}

/** The layout a kit starts with. One part sits at the origin turned by `params.rot` (as a single tool
 * always did); several parts lie as they were photographed, around their mean centre. Every part gets the
 * pocket settings in `params`. */
export function initialLayout(parts: readonly Part[], params: Params): Layout {
  const settings = settingsFromParams(params);
  if (parts.length === 1) return { placements: [{ part: parts[0]!.id, x: 0, y: 0, rot: params.rot, ...settings }] };
  const centres = parts.map((q): Vec2 => [q.up2sheet[0][2], q.up2sheet[1][2]]);
  const mx = centres.reduce((s, c) => s + c[0], 0) / Math.max(1, parts.length);
  const my = centres.reduce((s, c) => s + c[1], 0) / Math.max(1, parts.length);
  return {
    placements: parts.map((q, i) => ({
      part: q.id, x: centres[i]![0] - mx, y: centres[i]![1] - my, rot: normalizeDeg(affineAngle(q.up2sheet)), ...settings,
    })),
  };
}

/** A part-frame ring turned and moved into the bin by its placement. */
export function placeRing(ring: Ring, { x, y, rot }: Pick<Placement, 'x' | 'y' | 'rot'>): Ring {
  return rotate(ring, rot).map(([px, py]): Vec2 => [px + x, py + y]);
}

/** The angle (degrees from the part frame's y axis) of the axis a part snaps by: its mirror axis when the
 * part is symmetric enough, else its upright long axis (0). */
export function axisAngle(part: Pick<Part, 'symmetry'>): number {
  return part.symmetry.score >= AXIS_SCORE ? part.symmetry.axisDeg : 0;
}

const finite = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** A placement with its settings clamped like the inspector's (see clampParams), a finite position and its
 * angle folded into (-180, 180]. */
export function clampPlacement(pl: Placement, params: Params): Placement {
  const c = clampParams({ ...params, ...pl, rot: 0 });
  return {
    part: String(pl.part),
    x: clamp(finite(pl.x, 0), -1000, 1000),
    y: clamp(finite(pl.y, 0), -1000, 1000),
    rot: normalizeDeg(finite(pl.rot, 0)),
    ...settingsFromParams(c),
    ...(pl.hidden ? { hidden: true } : {}),
  };
}

/** The placements of `layout` whose part is in the kit, clamped (hidden ones kept); the initial layout
 * without one. */
export function resolveLayout(parts: readonly Part[], params: Params, layout?: Layout): Layout {
  if (!layout) return initialLayout(parts, params);
  const ids = new Set(parts.map((q) => q.id));
  const placements = layout.placements.filter((pl) => ids.has(pl.part)).map((pl) => clampPlacement(pl, params));
  return { placements, ...(layout.cells ? { cells: layout.cells } : {}) };
}
