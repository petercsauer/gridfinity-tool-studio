// Tracing an uploaded calibration-sheet photo. Implemented in segment 4c.
import type { Deps } from '../deps';
import { PipelineError, type ToolInfo } from '../protocol';

export async function upload(_file: Blob, _name: string, _deps: Deps): Promise<ToolInfo> {
  throw new PipelineError('not-implemented', 'Uploading photos is not implemented yet.');
}
