import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Ring, Vec2 } from '../geometry/pocket';
import { hausdorff, presetFixture, TOOLS } from '../test/fixtures';
import { readMaskPng } from '../test/maskpng';
import { getCv } from './opencv';
import { maskRect, outlineFromMask, type Affine } from './outline';

interface MaskFixture {
  mask_png: string;
  origin_mm: Vec2;
  px_per_mm: number;
  size_px: [number, number];
  foreground_px: number;
  min_area_rect_px: { centre: Vec2; size: [number, number]; angle_deg: number };
}

const maskFixture = (tool: string): MaskFixture =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/masks/${tool}.json`, import.meta.url)), 'utf-8'));

const apply = ([[a, b, c], [d, e, f]]: Affine, [x, y]: Vec2): Vec2 => [a * x + b * y + c, d * x + e * y + f];

/** cv.minAreaRect side lengths of a ring in mm, [short, long]. */
async function rectDims(P: Ring): Promise<[number, number]> {
  const cv = await getCv();
  const mat = cv.matFromArray(P.length, 1, cv.CV_32FC2, P.flat());
  try {
    const { size } = cv.minAreaRect(mat);
    return [Math.min(size.width, size.height), Math.max(size.width, size.height)];
  } finally {
    mat.delete();
  }
}

describe.each(TOOLS)('outlineFromMask %s', (tool) => {
  const fx = presetFixture(tool);
  const mf = maskFixture(tool);
  const mask = readMaskPng(mf.mask_png);

  it('decodes the preset mask and finds the same minAreaRect as cv2 (angle convention)', async () => {
    expect([mask.width, mask.height]).toEqual(mf.size_px);
    expect(Array.from(mask.data).filter((v) => v > 128).length).toBe(mf.foreground_px);
    const r = await maskRect(mask);
    const want = mf.min_area_rect_px;
    expect(r.centre[0]).toBeCloseTo(want.centre[0], 2);
    expect(r.centre[1]).toBeCloseTo(want.centre[1], 2);
    expect(r.size[0]).toBeCloseTo(want.size[0], 2);
    expect(r.size[1]).toBeCloseTo(want.size[1], 2);
    expect(r.angle).toBeCloseTo(want.angle_deg, 3);
  });

  it('matches the Python outline, crop and upright-to-sheet transform', async () => {
    const res = await outlineFromMask(mask, mf.origin_mm, mf.px_per_mm);
    expect(res.outline).toHaveLength(720);
    expect(res.crop[0]).toBeCloseTo(fx.crop_mm[0], 3);
    expect(res.crop[1]).toBeCloseTo(fx.crop_mm[1], 3);
    // upright: long axis vertical; same handedness and pose as Python (a flip would fail the Hausdorff bound)
    expect(res.crop[1]).toBeGreaterThan(res.crop[0]);
    expect(hausdorff(res.outline, fx.outline_mm)).toBeLessThan(0.5);
    const [ws, wl] = await rectDims(fx.outline_mm);
    const [gs, gl] = await rectDims(res.outline);
    expect(Math.abs(gs - ws)).toBeLessThan(0.3);
    expect(Math.abs(gl - wl)).toBeLessThan(0.3);
    let worst = 0;
    for (const q of fx.outline_mm) {
      const [ax, ay] = apply(res.up2sheet, q);
      const [bx, by] = apply(fx.up2sheet, q);
      worst = Math.max(worst, Math.hypot(ax - bx, ay - by));
    }
    expect(worst).toBeLessThan(0.5);
  });
});
