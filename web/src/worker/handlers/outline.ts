// The 2D trace: tool and pocket in the rotated outline frame (for sizing) and on the sheet.
import { bounds, effectiveDepth, footprint, makePocket, maxDepth, rotate, type Ring, type Vec2 } from '../../geometry/pocket';
import { clampParams, type Params } from '../../params';
import type { Deps } from '../deps';
import type { Measurements, OutlineResult } from '../protocol';
import type { Affine } from '../../vision/outline';

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

export async function outline(raw: Params, { manifold, presets }: Deps): Promise<OutlineResult> {
  const p = clampParams(raw);
  const preset = await presets.get(p.tool);
  const P0 = p.sym ? preset.symmetric_outline_mm : preset.outline_mm;
  const { tool, pocket } = makePocket(manifold, rotate(P0, p.rot), p);
  // the sheet shows the tool where it lies on the paper, so its pocket is made unrotated
  const onSheet = p.rot === 0 ? { tool, pocket } : makePocket(manifold, P0, p);
  const [nx, ny] = footprint(pocket, p.fillet, p.halfGrid);
  const xs = pocket.map((q) => q[0]);
  const ys = pocket.map((q) => q[1]);
  return {
    tool,
    pocket,
    sheetTool: affine(onSheet.tool, preset.up2sheet),
    sheetPocket: affine(onSheet.pocket, preset.up2sheet),
    ...(p.sym && preset.symmetry_axis
      ? { sheetAxis: affine(axisSegment(P0, preset.symmetry_axis), preset.up2sheet) as [Vec2, Vec2] }
      : {}),
    sheetBox: preset.sheet_box_mm,
    sheetImage: presets.url(preset.sheet_image),
    nx,
    ny,
    w: round(Math.max(...xs) - Math.min(...xs), 1),
    h: round(Math.max(...ys) - Math.min(...ys), 1),
    maxDepth: maxDepth(p.u, p),
    effectiveDepth: effectiveDepth(p.u, p.depth, p),
    symmetryScore: preset.symmetry_score,
    measure: measure(onSheet.tool, onSheet.pocket, preset.up2sheet),
  };
}
