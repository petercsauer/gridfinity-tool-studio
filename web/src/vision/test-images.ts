// Test-only image helpers: decode the repo's preset images in node (opencv.js has no imdecode), with the
// jpeg-js and pngjs decoders that @playwright/test already bundles.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { RGBAImage } from './sheet';

interface JpegJs {
  decode(data: Uint8Array, opts: { useTArray: true; formatAsRGBA: true }): { width: number; height: number; data: Uint8Array };
}
interface PngJs {
  sync: { read(data: Uint8Array): { width: number; height: number; data: Uint8Array } };
}
const { jpegjs, PNG } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle') as { jpegjs: JpegJs; PNG: PngJs };

const ROOT = new URL('../../../', import.meta.url);

const preset = (file: string) => readFileSync(fileURLToPath(new URL(`assets/presets/${file}`, ROOT)));
const rgba = (im: { width: number; height: number; data: Uint8Array }): RGBAImage =>
  ({ width: im.width, height: im.height, data: new Uint8ClampedArray(im.data.buffer, im.data.byteOffset, im.data.byteLength) });

/** Decode `assets/presets/<tool>.jpg` (the photo) to RGBA. */
export function presetPhoto(tool: string): RGBAImage {
  return rgba(jpegjs.decode(preset(`${tool}.jpg`), { useTArray: true, formatAsRGBA: true }));
}

/** Decode `assets/presets/<tool>_rect.png` (Python's rectification of the photo over REGION at 8 px/mm) to RGBA. */
export function presetRect(tool: string): RGBAImage {
  return rgba(PNG.sync.read(preset(`${tool}_rect.png`)));
}

/** A copy of `img` with the axis-aligned box spanning `pts` (plus `pad` px) painted white. */
export function blankOut(img: RGBAImage, pts: readonly (readonly [number, number])[], pad: number): RGBAImage {
  const out = { ...img, data: new Uint8ClampedArray(img.data) };
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  for (let y = Math.max(0, Math.floor(Math.min(...ys) - pad)); y < Math.min(img.height, Math.ceil(Math.max(...ys) + pad)); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(...xs) - pad)); x < Math.min(img.width, Math.ceil(Math.max(...xs) + pad)); x++) {
      out.data.fill(255, (y * img.width + x) * 4, (y * img.width + x) * 4 + 4);
    }
  }
  return out;
}

/** A `w` x `h` image of one colour. */
export function solid(w: number, h: number, rgb: [number, number, number]): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { width: w, height: h, data };
}
