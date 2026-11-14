// A kit's pockets: each part's tool and pocket made in its own upright frame with its own settings, then
// turned and moved into the bin by its placement. Shared by the outline and build handlers.
import type { ManifoldToplevel } from 'manifold-3d';
import { bounds, footprint, makePocket, type Ring, type Vec2 } from '../../geometry/pocket';
import { placeRing, resolveLayout, type Layout, type Part, type Placement } from '../../kit';
import { clamp, MAX_CELLS, type Params } from '../../params';
import { partsOf, type PresetData } from '../presets';
import { PipelineError } from '../protocol';

export interface PlacedPart {
  part: Part;
  placement: Placement;
  /** Tool and pocket in the part frame. */
  tool: Ring;
  pocket: Ring;
  /** The same placed in the bin (mm). */
  placedTool: Ring;
  placedPocket: Ring;
}

export interface PlacedKit {
  layout: Layout;
  /** Every placement whose part is in the kit, hidden ones included, in layout order. */
  all: PlacedPart[];
  /** The ones that get a pocket. */
  visible: PlacedPart[];
}

/** Make and place the pockets of `preset`'s parts for `layout` (or its initial layout). */
export function placeKit(m: ManifoldToplevel, preset: PresetData, p: Params, requested?: Layout): PlacedKit {
  const parts = partsOf(preset);
  const byId = new Map(parts.map((q) => [q.id, q]));
  const layout = resolveLayout(parts, p, requested);
  const all = layout.placements.map((pl): PlacedPart => {
    const part = byId.get(pl.part)!;
    const { tool, pocket } = makePocket(m, pl.sym ? part.symmetry.outline : part.outline, pl);
    return { part, placement: pl, tool, pocket, placedTool: placeRing(tool, pl), placedPocket: placeRing(pocket, pl) };
  });
  const visible = all.filter((q) => !q.placement.hidden);
  if (!visible.length) throw new PipelineError('invalid', 'Every part is hidden; show at least one to make a bin.');
  return { layout, all, visible };
}

/** The pockets moved so their combined bounding box is centred on the origin, as the bin's are. */
function centred(rings: readonly Ring[]): Ring[] {
  const b = bounds(rings.flat());
  const cx = (b.xmin + b.xmax) / 2;
  const cy = (b.ymin + b.ymax) / 2;
  return rings.map((P) => P.map(([x, y]): Vec2 => [x - cx, y - cy]));
}

export interface BinLayout {
  nx: number;
  ny: number;
  /** Whether the size is the layout's locked `cells`. */
  locked: boolean;
  /** The visible pockets where they are cut (mm, bin centred on the origin). */
  pockets: Ring[];
}

/** The bin for a kit: a locked size as given (whole cells, or half cells with half-grid feet, at most
 * MAX_CELLS) with the placements as bin coordinates; else the pockets' footprint with them centred. */
export function binLayout(kit: PlacedKit, p: Params): BinLayout {
  const placed = kit.visible.map((q) => q.placedPocket);
  const { cells } = kit.layout;
  if (cells) {
    const step = p.halfGrid ? 0.5 : 1;
    const n = (v: number) => clamp(Math.round((Number.isFinite(v) ? v : 1) / step) * step, step, MAX_CELLS);
    return { nx: n(cells[0]), ny: n(cells[1]), locked: true, pockets: placed };
  }
  const [nx, ny] = footprint(placed, p.fillet, p.halfGrid);
  return { nx, ny, locked: false, pockets: centred(placed) };
}
