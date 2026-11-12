// Background removal: IS-Net through onnxruntime-web, with rembg's DIS-session pre- and post-processing
// (rembg/sessions/base.py normalize, sessions/dis_general_use.py predict, bg.py post_process).
// Resizing is a port of Pillow's Lanczos resampler rather than cv.resize(INTER_LANCZOS4): Pillow widens the
// filter when it shrinks (antialiasing) and OpenCV doesn't, and the masks must match rembg's.
import type { InferenceSession } from 'onnxruntime-web';
import type { Mask } from './outline';
import { getCv } from './opencv';
import type { RGBAImage } from './sheet';

/** Model input size. */
export const SIZE = 1024;

const PRECISION_BITS = 22;   // Pillow's 8-bit resampling precision (32 - 8 - 2)
const ONE = 2 ** PRECISION_BITS;

const sinc = (x: number) => (x === 0 ? 1 : Math.sin(x * Math.PI) / (x * Math.PI));
const lanczos = (x: number) => (x >= -3 && x < 3 ? sinc(x) * sinc(x / 3) : 0);

interface Coeffs {
  /** Per output pixel: first input pixel and number of taps. */
  first: Int32Array;
  count: Int32Array;
  /** `ksize` fixed-point weights per output pixel. */
  k: Float64Array;
  ksize: number;
}

/** Pillow's precompute_coeffs + normalize_coeffs_8bpc for Lanczos over the whole input. */
function coeffs(inSize: number, outSize: number): Coeffs {
  const scale = inSize / outSize;
  const filterscale = Math.max(scale, 1);
  const support = 3 * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const first = new Int32Array(outSize);
  const count = new Int32Array(outSize);
  const k = new Float64Array(outSize * ksize);
  const w = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const xmin = Math.max(0, Math.trunc(center - support + 0.5));
    const n = Math.min(inSize, Math.trunc(center + support + 0.5)) - xmin;
    let ww = 0;
    for (let x = 0; x < n; x++) ww += (w[x] = lanczos((x + xmin - center + 0.5) / filterscale));
    for (let x = 0; x < n; x++) {
      const v = (ww !== 0 ? w[x]! / ww : w[x]!) * ONE;
      k[xx * ksize + x] = v < 0 ? Math.trunc(v - 0.5) : Math.trunc(v + 0.5);
    }
    first[xx] = xmin;
    count[xx] = n;
  }
  return { first, count, k, ksize };
}

const clip8 = (v: number) => (v >= ONE * 256 ? 255 : v <= 0 ? 0 : Math.floor(v / ONE));

/** One separable pass along x (`stride` 1) or y over interleaved `ch`-channel pixels. */
function pass(src: Uint8Array, w: number, h: number, ch: number, out: number, horizontal: boolean): Uint8Array {
  const c = coeffs(horizontal ? w : h, out);
  const ow = horizontal ? out : w;
  const oh = horizontal ? h : out;
  const dst = new Uint8Array(ow * oh * ch);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const o = horizontal ? x : y;
      const base = o * c.ksize;
      const f = c.first[o]!;
      const n = c.count[o]!;
      for (let b = 0; b < ch; b++) {
        let ss = ONE / 2;
        for (let i = 0; i < n; i++) {
          const at = horizontal ? (y * w + f + i) * ch + b : ((f + i) * w + x) * ch + b;
          ss += src[at]! * c.k[base + i]!;
        }
        dst[(y * ow + x) * ch + b] = clip8(ss);
      }
    }
  }
  return dst;
}

/** Pillow's `Image.resize(size, LANCZOS)` for 8-bit interleaved pixels: horizontal pass, then vertical. */
export function resizeLanczos(src: Uint8Array, w: number, h: number, ch: number, ow: number, oh: number): Uint8Array {
  let out = src;
  if (ow !== w) out = pass(out, w, h, ch, ow, true);
  if (oh !== h) out = pass(out, ow, h, ch, oh, false);
  return out === src ? src.slice() : out;
}

/** rembg's DIS input: RGB, Lanczos to 1024x1024, divided by the image max, minus 0.5; NCHW float32. */
export function toInput(img: RGBAImage): Float32Array {
  const n = img.width * img.height;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = img.data[i * 4]!;
    rgb[i * 3 + 1] = img.data[i * 4 + 1]!;
    rgb[i * 3 + 2] = img.data[i * 4 + 2]!;
  }
  const im = resizeLanczos(rgb, img.width, img.height, 3, SIZE, SIZE);
  let max = 0;
  for (const v of im) if (v > max) max = v;
  const div = Math.max(max, 1e-6);
  const plane = SIZE * SIZE;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let b = 0; b < 3; b++) out[b * plane + i] = im[i * 3 + b]! / div - 0.5;
  }
  return out;
}

/** rembg's DIS output: channel 0 min-max normalised, to uint8 (truncating, in float32 as numpy does). */
export function toGray(pred: Float32Array): Uint8Array {
  let mi = Infinity;
  let ma = -Infinity;
  for (let i = 0; i < SIZE * SIZE; i++) {
    const v = pred[i]!;
    if (v < mi) mi = v;
    if (v > ma) ma = v;
  }
  const f = Math.fround;
  const range = f(ma - mi);
  const out = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) out[i] = Math.trunc(f(f(f(pred[i]! - mi) / range) * 255));
  return out;
}

/** rembg's post_process: grey opening with disk(1), Gaussian blur sigma 2 (scipy: reflect, radius 8), then
 * < 127 -> 0, else 255. */
export async function postProcess(gray: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const cv = await getCv();
  const src = cv.matFromArray(height, width, cv.CV_8UC1, gray);
  const kernel = cv.getStructuringElement(cv.MORPH_CROSS, new cv.Size(3, 3));
  const opened = new cv.Mat();
  const f = new cv.Mat();
  const blurred = new cv.Mat();
  try {
    cv.morphologyEx(src, opened, cv.MORPH_OPEN, kernel, new cv.Point(-1, -1), 1, cv.BORDER_REFLECT, new cv.Scalar(0));
    opened.convertTo(f, cv.CV_64F);
    cv.GaussianBlur(f, blurred, new cv.Size(17, 17), 2, 2, cv.BORDER_REFLECT);
    const b = blurred.data64F as Float64Array;
    const out = new Uint8Array(width * height);
    for (let i = 0; i < out.length; i++) out[i] = b[i]! < 127 ? 0 : 255;
    return out;
  } finally {
    for (const m of [src, kernel, opened, f, blurred]) m.delete();
  }
}

/** Foreground mask (0 or 255) of `img`, as rembg.remove(only_mask=True, post_process_mask=True) gives it. */
export async function segment(session: InferenceSession, img: RGBAImage): Promise<Mask> {
  const { Tensor } = await import('onnxruntime-web');
  const input = new Tensor('float32', toInput(img), [1, 3, SIZE, SIZE]);
  const outputs = await session.run({ [session.inputNames[0]!]: input });
  const pred = outputs[session.outputNames[0]!]!;
  try {
    const gray = toGray(pred.data as Float32Array);
    const full = resizeLanczos(gray, SIZE, SIZE, 1, img.width, img.height);
    return { width: img.width, height: img.height, data: await postProcess(full, img.width, img.height) };
  } finally {
    input.dispose();
    pred.dispose();
  }
}
