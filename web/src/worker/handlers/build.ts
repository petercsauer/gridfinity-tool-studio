// The 3D bin: the kit's pockets for the current parameters and layout, each cut at its own depth into a
// gridfinity bin of the layout's locked size or one that fits them.
import { genbin } from '../../geometry/bin';
import type { Layout } from '../../kit';
import { clampParams, MAX_CELLS, type Params } from '../../params';
import type { Deps } from '../deps';
import { PipelineError, type BuildResult } from '../protocol';
import { binLayout, placeKit } from './placed';

export async function build(raw: Params, { manifold, presets }: Deps, layout?: Layout): Promise<BuildResult> {
  const p = clampParams(raw);
  const kit = placeKit(manifold, await presets.get(p.tool), p, layout);
  const { nx, ny, pockets } = binLayout(kit, p);
  if (nx > MAX_CELLS || ny > MAX_CELLS) {
    throw new PipelineError('too-large', `This tool needs a ${nx}×${ny} bin; the largest is ${MAX_CELLS}×${MAX_CELLS}.`);
  }
  const cuts = pockets.map((ring, i) => ({ ring, depth: kit.visible[i]!.placement.depth }));
  const bin = genbin(manifold, cuts, nx, ny, p);
  const depths = new Map(kit.visible.map((q, i) => [q, bin.effectiveDepths[i]!]));
  return {
    positions: bin.positions,
    indices: bin.indices,
    effectiveDepth: bin.effectiveDepth,
    effectiveDepths: kit.all.map((q) => depths.get(q) ?? 0),
    nx,
    ny,
  };
}
