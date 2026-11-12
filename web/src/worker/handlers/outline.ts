// The 2D trace: tool and pocket in the rotated outline frame (for sizing) and on the sheet.
import { effectiveDepth, footprint, makePocket, maxDepth, rotate, type Ring } from '../../geometry/pocket';
import { clampParams, type Params } from '../../params';
import type { Deps } from '../deps';
import type { OutlineResult } from '../protocol';

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** Apply a 2x3 affine [A | b] to every point. */
function affine(P: Ring, [[a, b, c], [d, e, f]]: [[number, number, number], [number, number, number]]): Ring {
  return P.map(([x, y]) => [round(a * x + b * y + c, 2), round(d * x + e * y + f, 2)]);
}

export async function outline(raw: Params, { manifold, presets }: Deps): Promise<OutlineResult> {
  const p = clampParams(raw);
  const preset = await presets.get(p.tool);
  const P0 = p.sym ? preset.symmetric_outline_mm : preset.outline_mm;
  const { tool, pocket } = makePocket(manifold, rotate(P0, p.rot), p);
  // the sheet shows the tool where it lies on the paper, so its pocket is made unrotated
  const onSheet = p.rot === 0 ? { tool, pocket } : makePocket(manifold, P0, p);
  const [nx, ny] = footprint(pocket, p.fillet);
  const xs = pocket.map((q) => q[0]);
  const ys = pocket.map((q) => q[1]);
  return {
    tool,
    pocket,
    sheetTool: affine(onSheet.tool, preset.up2sheet),
    sheetPocket: affine(onSheet.pocket, preset.up2sheet),
    sheetBox: preset.sheet_box_mm,
    sheetImage: presets.url(preset.sheet_image),
    nx,
    ny,
    w: round(Math.max(...xs) - Math.min(...xs), 1),
    h: round(Math.max(...ys) - Math.min(...ys), 1),
    maxDepth: maxDepth(p.u),
    effectiveDepth: effectiveDepth(p.u, p.depth),
  };
}
