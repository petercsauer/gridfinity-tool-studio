// The 3D bin: the pocket for the current parameters, centred, cut into a gridfinity bin.
import { genbin } from '../../geometry/bin';
import { bounds, footprint, makePocket, rotate } from '../../geometry/pocket';
import { clampParams, MAX_CELLS, type Params } from '../../params';
import type { Deps } from '../deps';
import { PipelineError, type BuildResult } from '../protocol';

export async function build(raw: Params, { manifold, presets }: Deps): Promise<BuildResult> {
  const p = clampParams(raw);
  const preset = await presets.get(p.tool);
  const P0 = p.sym ? preset.symmetric_outline_mm : preset.outline_mm;
  const { pocket } = makePocket(manifold, rotate(P0, p.rot), p);
  const [nx, ny] = footprint(pocket, p.fillet, p.halfGrid);
  if (nx > MAX_CELLS || ny > MAX_CELLS) {
    throw new PipelineError('too-large', `This tool needs a ${nx}×${ny} bin; the largest is ${MAX_CELLS}×${MAX_CELLS}.`);
  }
  const b = bounds(pocket);
  const cx = (b.xmin + b.xmax) / 2;
  const cy = (b.ymin + b.ymax) / 2;
  const centred = pocket.map(([x, y]) => [x - cx, y - cy] as [number, number]);
  const bin = genbin(manifold, centred, nx, ny, p);
  return { positions: bin.positions, indices: bin.indices, effectiveDepth: bin.effectiveDepth, nx, ny };
}
