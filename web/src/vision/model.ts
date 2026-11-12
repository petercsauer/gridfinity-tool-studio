// The IS-Net background-removal model: download once (with progress) into the Cache API, then an
// onnxruntime-web session (WebGPU when available, else WASM). The ORT wasm files come from jsDelivr at the
// installed version, so they are not part of the deploy (each is over the 25 MiB static-asset limit).
import type { InferenceSession } from 'onnxruntime-web';
import { PipelineError } from '../worker/protocol';

/** IS-Net general-use, fp16 weights with float32 input and output (MIT, imgly/isnet-general-onnx). */
export const MODEL_URL = 'https://huggingface.co/imgly/isnet-general-onnx/resolve/main/onnx/model_fp16.onnx';
/** Its size in bytes, for progress when the response has no Content-Length. */
export const MODEL_BYTES = 88_152_708;
/** Cache API bucket; bump the suffix when the model changes. */
export const MODEL_CACHE = 'gts-model-v1';

/** Download progress in bytes. */
export type Progress = (loaded: number, total: number) => void;

/** Whether the model is already in the Cache API (no download needed). */
export async function modelCached(): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  return !!(await (await caches.open(MODEL_CACHE)).match(MODEL_URL));
}

/** Read a response body, reporting progress after every chunk. */
async function readAll(res: Response, onProgress?: Progress): Promise<Uint8Array<ArrayBuffer>> {
  const total = Number(res.headers.get('content-length')) || MODEL_BYTES;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, Math.max(total, loaded));
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** The model bytes: from the Cache API if present, else downloaded (with progress) and cached. */
export async function loadModel(onProgress?: Progress): Promise<Uint8Array<ArrayBuffer>> {
  const cache = typeof caches === 'undefined' ? null : await caches.open(MODEL_CACHE);
  const hit = await cache?.match(MODEL_URL);
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer());
    onProgress?.(bytes.byteLength, bytes.byteLength);
    return bytes;
  }
  let res: Response;
  try {
    res = await fetch(MODEL_URL, { redirect: 'follow' });
  } catch {
    throw new PipelineError('model', 'Couldn\'t download the background-removal model. Check your connection and try again.');
  }
  if (!res.ok) throw new PipelineError('model', `Couldn't download the background-removal model (HTTP ${res.status}).`);
  const bytes = await readAll(res, onProgress);
  await cache?.put(MODEL_URL, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
  return bytes;
}

const inNode = typeof process !== 'undefined' && !!process.versions?.node;

/** An inference session over the model bytes. In the browser: WebGPU if the device has it, else WASM. */
export async function createSession(model: Uint8Array): Promise<InferenceSession> {
  const ort = await import('onnxruntime-web');
  const providers: string[] = ['wasm'];
  if (!inNode) {
    ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
    // threads need SharedArrayBuffer, which needs cross-origin isolation
    if (!globalThis.crossOriginIsolated) ort.env.wasm.numThreads = 1;
    if ((globalThis.navigator as { gpu?: unknown } | undefined)?.gpu) providers.unshift('webgpu');
  }
  return ort.InferenceSession.create(model, { executionProviders: providers, graphOptimizationLevel: 'all' });
}

let session: Promise<InferenceSession> | null = null;

/** The shared session, downloading the model on first use. `onProgress` sees the download, if one happens. */
export function getSession(onProgress?: Progress): Promise<InferenceSession> {
  if (!session) {
    const s = loadModel(onProgress).then(createSession);
    s.catch(() => { if (session === s) session = null; });   // a failed download can be retried
    session = s;
  }
  return session;
}
