// Test helper: the IS-Net model for the segmentation tests, downloaded once to web/.cache/ (gitignored).
// Resolves to null when it isn't cached and can't be downloaded, so those tests skip instead of failing.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { InferenceSession } from 'onnxruntime-web';
import { createSession, MODEL_BYTES, MODEL_URL } from '../vision/model';

const DIR = fileURLToPath(new URL('../../.cache/', import.meta.url));
export const MODEL_PATH = `${DIR}model_fp16.onnx`;

async function modelBytes(): Promise<Uint8Array | null> {
  if (!existsSync(MODEL_PATH)) {
    try {
      const res = await fetch(MODEL_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength !== MODEL_BYTES) throw new Error(`got ${bytes.byteLength} bytes`);
      mkdirSync(DIR, { recursive: true });
      // test files run in parallel: write aside, then rename into place atomically
      const part = `${MODEL_PATH}.${process.pid}.part`;
      writeFileSync(part, bytes);
      renameSync(part, MODEL_PATH);
    } catch (e) {
      console.warn(`Skipping the model tests: couldn't download ${MODEL_URL} to ${MODEL_PATH} (${String(e)}).`);
      return null;
    }
  }
  return new Uint8Array(readFileSync(MODEL_PATH));
}

let session: Promise<InferenceSession | null> | null = null;

/** The shared test session (WASM backend), or null when the model is unavailable. */
export function testSession(): Promise<InferenceSession | null> {
  session ??= modelBytes().then((b) => (b ? createSession(b) : null));
  return session;
}
