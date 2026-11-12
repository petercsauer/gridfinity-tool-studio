// Gridfinity and pocket constants, mirroring src/gts/constants.py (kennetek standard.scad).

export const GRID = 42;
export const GAP = 0.5;
export const UHT = 7;
/** Stacking-lip trough inset from the outer wall: rim 1.8 + lead-in 1.4. */
export const LIP_INSET = 1.8 + 1.4;
/** Minimum wall between the pocket opening and the lip trough. */
export const MIN_WALL = 1.2;
/** The pocket opens this far below the bin top (lip trough floor). */
export const RECESS = 4.4;
/** Lowest pocket floor: top of the feet plus a 0.8 mm floor. */
export const FLOOR_MIN = 4.75 + 0.8;
/** Finger-slot position is clamped to this fraction of the pocket height. */
export const SLOT_FRAC_RANGE: readonly [number, number] = [0.02, 0.98];
/** Segments per full circle for round offsets and the slot (shapely quad_segs=16). */
export const CIRCULAR_SEGMENTS = 64;
