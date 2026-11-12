// The 3D bin. Implemented in segment 3; until then the preview reports that it is missing.
import type { Params } from '../../params';
import type { Deps } from '../deps';
import { PipelineError, type BuildResult } from '../protocol';

export async function build(_params: Params, _deps: Deps): Promise<BuildResult> {
  throw new PipelineError('not-implemented', '3D preview not implemented yet');
}
