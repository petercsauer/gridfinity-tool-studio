// The 2D trace: every part's tool and pocket in its own frame (the layout places them), on the sheet where it
// was photographed, and the footprint of the placed pockets.
import { bounds, effectiveDepth, footprint, maxDepth, rotate, type Ring, type Vec2 } from '../../geometry/pocket';
import { axisAngle, type Layout } from '../../kit';
import { clampParams, type Params } from '../../params';
import type { Deps } from '../deps';
import type { Measurements, OutlineResult, PartTrace } from '../protocol';
import type { Affine } from '../../vision/outline';
import { placeKit, type PlacedPart } from './placed';

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** Apply a 2x3 affine [A | b] to every point. */
function affine(P: Ring, [[a, b, c], [d, e, f]]: [[number, number, number], [number, number, number]]): Ring {
  return P.map(([x, y]) => [round(a * x + b * y + c, 2), round(d * x + e * y + f, 2)]);
}

/** The mirror axis as a segment running 6 mm past both ends of `P` (outline mm). */
function axisSegment(P: Ring, { deg, offset, centre: [cx, cy] }: { deg: number; offset: number; centre: Vec2 }): Ring {
  const ys = rotate(P.map(([x, y]): Vec2 => [x - cx, y - cy]), -deg).map((q) => q[1]);
  const ends: Ring = [[offset, Math.min(...ys) - 6], [offset, Math.max(...ys) + 6]];
  return rotate(ends, deg).map(([x, y]): Vec2 => [x + cx, y + cy]);
}

/** Pocket and tool boxes in the upright frame, their sizes and the gap between them on each side. */
export function measure(tool: Ring, pocket: Ring, up2sheet: Affine): Measurements {
  const t = bounds(tool);
  const k = bounds(pocket);
  return {
    pocket: k,
    tool: t,
    up2sheet,
    pocketSize: [round(k.xmax - k.xmin, 1), round(k.ymax - k.ymin, 1)],
    toolSize: [round(t.xmax - t.xmin, 1), round(t.ymax - t.ymin, 1)],
    gaps: {
      xmin: round(t.xmin - k.xmin, 1), xmax: round(k.xmax - t.xmax, 1),
      ymin: round(t.ymin - k.ymin, 1), ymax: round(k.ymax - t.ymax, 1),
    },
  };
}

function partTrace({ part, placement, tool, pocket }: PlacedPart): PartTrace {
  const { symmetry: sy, up2sheet } = part;
  const P0 = placement.sym ? sy.outline : part.outline;
  return {
    id: part.id,
    tool,
    pocket,
    sheetTool: affine(tool, up2sheet),
    sheetPocket: affine(pocket, up2sheet),
    ...(placement.sym
      ? { sheetAxis: affine(axisSegment(P0, { deg: sy.axisDeg, offset: sy.offset, centre: sy.centre }), up2sheet) as [Vec2, Vec2] }
      : {}),
    symmetryScore: sy.score,
    axisDeg: axisAngle(part),
    measure: measure(tool, pocket, up2sheet),
  };
}

export async function outline(raw: Params, { manifold, presets }: Deps, layout?: Layout): Promise<OutlineResult> {
  const p = clampParams(raw);
  const preset = await presets.get(p.tool);
  const kit = placeKit(manifold, preset, p, layout);
  const parts = kit.all.map(partTrace);
  const first = kit.visible[0]!;
  const firstTrace = parts[kit.all.indexOf(first)]!;
  const pockets = kit.visible.map((q) => q.placedPocket);
  const [nx, ny] = footprint(pockets, p.fillet, p.halfGrid);
  const b = bounds(pockets.flat());
  const depth = Math.max(...kit.visible.map((q) => q.placement.depth));
  return {
    parts,
    layout: kit.layout,
    tool: first.placedTool,
    pocket: first.placedPocket,
    sheetTool: firstTrace.sheetTool,
    sheetPocket: firstTrace.sheetPocket,
    ...(firstTrace.sheetAxis ? { sheetAxis: firstTrace.sheetAxis } : {}),
    sheetBox: preset.sheet_box_mm,
    sheetImage: presets.url(preset.sheet_image),
    nx,
    ny,
    w: round(b.xmax - b.xmin, 1),
    h: round(b.ymax - b.ymin, 1),
    maxDepth: maxDepth(p.u, p),
    effectiveDepth: effectiveDepth(p.u, depth, p),
    symmetryScore: firstTrace.symmetryScore,
    measure: firstTrace.measure,
  };
}
