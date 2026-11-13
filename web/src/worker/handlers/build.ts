// The 3D bin: the kit's pockets for the current parameters and layout, centred, cut into a gridfinity bin.
import { genbin } from '../../geometry/bin';
import { footprint } from '../../geometry/pocket';
import type { Layout } from '../../kit';
import { clampParams, MAX_CELLS, type Params } from '../../params';
import type { Deps } from '../deps';
import { PipelineError, type BuildResult } from '../protocol';
import { centred, placeKit } from './placed';

export async function build(raw: Params, { manifold, presets }: Deps, layout?: Layout): Promise<BuildResult> {
  const p = clampParams(raw);
  const kit = placeKit(manifold, await presets.get(p.tool), p, layout);
  const pockets = kit.visible.map((q) => q.placedPocket);
  const [nx, ny] = footprint(pockets, p.fillet, p.halfGrid);
  if (nx > MAX_CELLS || ny > MAX_CELLS) {
    throw new PipelineError('too-large', `This tool needs a ${nx}×${ny} bin; the largest is ${MAX_CELLS}×${MAX_CELLS}.`);
  }
  // one depth for the whole bin: the deepest part's
  const depth = Math.max(...kit.visible.map((q) => q.placement.depth));
  const bin = genbin(manifold, centred(pockets), nx, ny, { ...p, depth });
  return { positions: bin.positions, indices: bin.indices, effectiveDepth: bin.effectiveDepth, nx, ny };
}
