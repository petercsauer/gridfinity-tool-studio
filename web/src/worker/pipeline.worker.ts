// The pipeline worker: answers protocol requests with the handlers in ./handlers.
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { initManifold } from '../geometry/manifold';
import { build } from './handlers/build';
import { outline } from './handlers/outline';
import { upload, workerUploadEnv } from './handlers/upload';
import type { Deps } from './deps';
import { fetchPresets, withUploads, type ToolSource } from './presets';
import { isOutOfMemory, memoryError, PipelineError, type ProgressMessage, type Request, type Response, type Results } from './protocol';

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<Request>) => void): void;
}
const scope = self as unknown as WorkerScope;

let presets: ToolSource | null = null;

function configured(): ToolSource {
  if (!presets) throw new PipelineError('internal', 'The worker was not configured.');
  return presets;
}

async function deps(): Promise<Deps> {
  return { presets: configured(), manifold: await initManifold(wasmUrl) };
}

async function handle(req: Request): Promise<Results[Request['kind']]> {
  switch (req.kind) {
    case 'configure':
      presets = withUploads(fetchPresets(req.assetBase));
      return null;
    case 'listTools':
      return configured().list();
    case 'outline':
      return outline(req.params, await deps(), req.layout);
    case 'build':
      return build(req.params, await deps(), req.layout);
    case 'upload': {
      const post = (progress: ProgressMessage['progress']) => scope.postMessage({ id: req.id, progress } satisfies ProgressMessage);
      const env = workerUploadEnv((loaded, total) => post({ stage: 'model', loaded, total }), (stage) => post({ stage }));
      return upload(req.image, req.name, await deps(), env);
    }
    // synchronous, so a later outline or build request already sees the tool
    case 'addTool':
      configured().add(req.tool);
      return null;
    case 'removeTool':
      configured().remove(req.id);
      return null;
  }
}

/** Typed-array buffers in a result, moved to the UI thread instead of copied. */
function transferables(result: unknown): Transferable[] {
  if (!result || typeof result !== 'object') return [];
  return Object.values(result).filter(ArrayBuffer.isView).map((v) => v.buffer as ArrayBuffer);
}

scope.addEventListener('message', async ({ data: req }) => {
  const { id, kind, version } = req;
  let res: Response;
  try {
    const result = await handle(req);
    res = { id, kind, version, ok: true, result } as Response;
  } catch (e) {
    const err = e instanceof PipelineError ? e
      : isOutOfMemory(e) ? memoryError() : new PipelineError('internal', `Processing failed: ${String(e)}`);
    res = { id, kind, version, ok: false, code: err.code, error: err.message } as Response;
  }
  scope.postMessage(res, res.ok ? transferables(res.result) : []);
});
