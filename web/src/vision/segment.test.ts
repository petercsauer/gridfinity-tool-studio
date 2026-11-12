import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../test/fixtures';
import { readMaskPng } from '../test/maskpng';
import { testSession } from '../test/model';
import { postProcess, resizeLanczos, segment, SIZE, toGray, toInput } from './segment';
import { rectRegion, type Box, type Homography } from './sheet';
import { presetPhoto, solid } from './test-images';

const fixture = (dir: string, tool: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/${dir}/${tool}.json`, import.meta.url)), 'utf-8'));

/** Intersection over union of the > 128 pixels of two equal-size masks. */
function iou(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]! > 128;
    const q = b[i]! > 128;
    if (p && q) inter++;
    if (p || q) union++;
  }
  return inter / union;
}

describe('Pillow Lanczos resize', () => {
  it('keeps a flat image flat when shrinking and enlarging', () => {
    const flat = new Uint8Array(37 * 23 * 3).fill(173);
    expect(resizeLanczos(flat, 37, 23, 3, 10, 50).every((v) => v === 173)).toBe(true);
  });

  it('matches Pillow on a small ramp (values from PIL.Image.resize(LANCZOS))', () => {
    // Image.fromarray(np.arange(0, 250, 25, dtype=np.uint8)[None]).resize((4, 1), Image.Resampling.LANCZOS)
    const ramp = Uint8Array.from({ length: 10 }, (_, i) => i * 25);
    expect([...resizeLanczos(ramp, 10, 1, 1, 4, 1)]).toEqual([19, 80, 145, 206]);
  });
});

describe('rembg pre- and post-processing', () => {
  it('scales by the image max and centres on zero', () => {
    const x = toInput(solid(300, 200, [100, 50, 0]));
    expect(x.length).toBe(3 * SIZE * SIZE);
    expect([x[0], x[SIZE * SIZE], x[2 * SIZE * SIZE]]).toEqual([0.5, 0, -0.5]);
  });

  it('min-max normalises the prediction to 0..255', () => {
    const pred = new Float32Array(SIZE * SIZE).fill(-2);
    pred[1] = 3;
    pred[2] = 0.5;
    expect([...toGray(pred).subarray(0, 3)]).toEqual([0, 255, 127]);
  });

  it('opens away specks and thresholds the blur at 127', async () => {
    const w = 40;
    const m = new Uint8Array(w * w);
    m[5 * w + 5] = 255;   // a speck the opening removes
    for (let y = 15; y < 35; y++) for (let x = 15; x < 35; x++) m[y * w + x] = 255;
    const out = await postProcess(m, w, w);
    expect(out[5 * w + 5]).toBe(0);
    expect(out[25 * w + 25]).toBe(255);
    expect(new Set(out)).toEqual(new Set([0, 255]));
  });
});

const session = await testSession();

describe.skipIf(!session)('IS-Net masks', () => {
  it.each(TOOLS)('%s: IoU >= 0.98 with the Python mask over the same region', async (tool) => {
    const mf = fixture('masks', tool) as { mask_png: string; region_mm: Box; px_per_mm: number };
    const H = (fixture('presets', tool) as { homography: Homography }).homography;
    const { canvas } = await rectRegion(presetPhoto(tool), H, mf.region_mm, mf.px_per_mm);
    const mask = await segment(session!, canvas);
    const want = readMaskPng(mf.mask_png);
    expect([mask.width, mask.height]).toEqual([want.width, want.height]);
    expect(iou(mask.data, want.data)).toBeGreaterThanOrEqual(0.98);
  }, 60000);
});
