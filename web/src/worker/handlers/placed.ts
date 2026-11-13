// A kit's pockets: each part's tool and pocket made in its own upright frame with its own settings, then
// turned and moved into the bin by its placement. Shared by the outline and build handlers.
import type { ManifoldToplevel } from 'manifold-3d';
import { bounds, makePocket, type Ring, type Vec2 } from '../../geometry/pocket';
import { placeRing, resolveLayout, type Layout, type Part, type Placement } from '../../kit';
import type { Params } from '../../params';
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
export function centred(rings: readonly Ring[]): Ring[] {
  const b = bounds(rings.flat());
  const cx = (b.xmin + b.xmax) / 2;
  const cy = (b.ymin + b.ymax) / 2;
  return rings.map((P) => P.map(([x, y]): Vec2 => [x - cx, y - cy]));
}
