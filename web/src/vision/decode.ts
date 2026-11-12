// Photo decoding: File/Blob to RGBA pixels, downscaled so the long side is at most MAX_SIDE px.
// Uses the browser's decoder (createImageBitmap, EXIF orientation applied); HEIC/HEIF photos the browser can't
// decode are converted to JPEG by heic2any, loaded lazily as its own chunk. heic2any needs `window` and
// `document`, so HEIC fallback works only on the UI thread; everything else works in a worker too.
import { PipelineError } from '../worker/protocol';

/** Longest side of a decoded photo (keeps >= 12 px/mm on the sheet, above the 8 px/mm working scale). */
export const MAX_SIDE = 4000;

/** Size that fits `w` x `h` inside MAX_SIDE on the long side, keeping the aspect ratio (never upscales). */
export function fitSize(w: number, h: number, max = MAX_SIDE): [number, number] {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

/** Whether a file is HEIC/HEIF, by MIME type or, when the type is missing, by extension. */
export function isHeic(type: string, name: string): boolean {
  return /^image\/hei[cf](-sequence)?$/i.test(type) || /\.hei[cf]$/i.test(name);
}

/** The platform calls decodePhoto uses; replaceable for tests. */
export interface DecodeEnv {
  createImageBitmap(blob: Blob): Promise<ImageBitmap>;
  /** HEIC/HEIF to JPEG. */
  heicToJpeg(blob: Blob): Promise<Blob>;
  /** Draw a bitmap at `w` x `h` and read its pixels back. */
  rasterize(bitmap: ImageBitmap, w: number, h: number): ImageData;
}

async function heicToJpeg(blob: Blob): Promise<Blob> {
  const { default: heic2any } = await import('heic2any');
  const out = await heic2any({ blob, toType: 'image/jpeg', quality: 0.95 });
  return Array.isArray(out) ? out[0]! : out;
}

function rasterize(bitmap: ImageBitmap, w: number, h: number): ImageData {
  const ctx = new OffscreenCanvas(w, h).getContext('2d');
  if (!ctx) throw new PipelineError('internal', 'This browser cannot draw images off screen.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

const browserEnv: DecodeEnv = {
  createImageBitmap: (blob) => createImageBitmap(blob, { imageOrientation: 'from-image' }),
  heicToJpeg,
  rasterize,
};

/** Decode a photo to RGBA pixels with the long side at most MAX_SIDE px. */
export async function decodePhoto(file: Blob, name = '', env: DecodeEnv = browserEnv): Promise<ImageData> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await env.createImageBitmap(file);
  } catch {
    if (!isHeic(file.type, name)) {
      throw new PipelineError('invalid', 'This file could not be read as an image. Use a JPEG, PNG or HEIC photo.');
    }
    try {
      bitmap = await env.createImageBitmap(await env.heicToJpeg(file));
    } catch {
      throw new PipelineError('invalid', 'This HEIC photo could not be converted. Export it as JPEG and try again.');
    }
  }
  try {
    const [w, h] = fitSize(bitmap.width, bitmap.height);
    return env.rasterize(bitmap, w, h);
  } finally {
    bitmap.close();
  }
}
