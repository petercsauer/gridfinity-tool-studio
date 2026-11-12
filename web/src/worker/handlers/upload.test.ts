import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initManifold } from '../../geometry/manifold';
import type { Ring, Vec2 } from '../../geometry/pocket';
import { hausdorff, presetFixture, TOOLS } from '../../test/fixtures';
import { testSession } from '../../test/model';
import { getCv } from '../../vision/opencv';
import type { Affine } from '../../vision/outline';
import { segment } from '../../vision/segment';
import { renderSheetView, SHEET, type Corners, type Homography, type RGBAImage } from '../../vision/sheet';
import { blankOut, presetPhoto, solid } from '../../vision/test-images';
import type { Deps } from '../deps';
import { PipelineError, type UploadResult } from '../protocol';
import { upload, type UploadEnv } from './upload';

const sheetFixture = (tool: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../tests/fixtures/presets/${tool}.json`, import.meta.url)), 'utf-8')) as
    { homography: Homography; marker_corners_px: Record<string, Corners> };

const apply = ([[a, b, c], [d, e, f]]: Affine, P: Ring): Ring => P.map(([x, y]): Vec2 => [a * x + b * y + c, d * x + e * y + f]);

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

/** Expect `p` to reject with a PipelineError of `code`. */
async function rejects(p: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(PipelineError);
  expect((e as PipelineError).code).toBe(code);
  if (message) expect((e as PipelineError).message).toMatch(message);
}

let deps: Deps;
beforeAll(async () => {
  deps = { manifold: await initManifold(), presets: null as never };
});

/** An environment whose segmentation must not be reached. */
const noModel: UploadEnv = {
  segment: () => Promise.reject(new Error('segment should not run')),
  encodeJpeg: () => Promise.reject(new Error('encodeJpeg should not run')),
};

describe('upload rejects, before any segmentation,', () => {
  it('pixels that do not form an image', async () => {
    await rejects(upload({ width: 10, height: 10, data: new Uint8ClampedArray(7) }, 'x', deps, noModel), 'invalid');
  });

  it('a photo over the size limit', async () => {
    await rejects(upload({ width: 4001, height: 1, data: new Uint8ClampedArray(4001 * 4) }, 'x', deps, noModel), 'too-large');
  });

  it('a photo without the calibration sheet', async () => {
    await rejects(upload(solid(800, 600, [200, 180, 150]), 'x', deps, noModel), 'no-sheet', /found 0 of 4 markers; missing 0, 1, 2, 3/);
  });

  it('a photo with a marker covered', async () => {
    const corners = sheetFixture('stripper').marker_corners_px['2']!;
    await rejects(upload(blankOut(presetPhoto('stripper'), corners, 10), 'x', deps, noModel), 'no-sheet', /missing 2\)/);
  });
});

it('upload rejects a sheet with nothing on it', async () => {
  const empty: UploadEnv = {
    segment: async ({ width, height }) => ({ width, height, data: new Uint8Array(width * height) }),
    encodeJpeg: noModel.encodeJpeg,
  };
  await rejects(upload(presetPhoto('stripper'), 'x', deps, empty), 'no-tool', /no tool was detected/);
});

const session = await testSession();

/** The real model, and a JPEG encoder that records what it was given (node has no OffscreenCanvas). */
function modelEnv(): UploadEnv & { encoded: RGBAImage[] } {
  const encoded: RGBAImage[] = [];
  return {
    encoded,
    segment: (img) => segment(session!, img),
    encodeJpeg: async (img) => {
      encoded.push(img);
      return new Blob([], { type: 'image/jpeg' });
    },
  };
}

/** A flat, top-down "photo" of a preset's sheet at 4 px/mm with the band between the marker rows (sheet
 * y 50..229 mm) moved `shift` mm to the left, so the tool runs off the photo while every marker stays in it. */
async function shiftedSheet(tool: string, shift: number): Promise<RGBAImage> {
  const px = 4;
  const fx = presetFixture(tool);
  const { image, box } = await renderSheetView(presetPhoto(tool), sheetFixture(tool).homography, apply(fx.up2sheet, fx.outline_mm), px);
  const { width: w, height: h, data } = image;
  const median = (c: number) => {
    const v = Array.from({ length: w * h }, (_, i) => data[i * 4 + c]!).sort((a, b) => a - b);
    return v[v.length >> 1]!;
  };
  const paper = [median(0), median(1), median(2), 255];
  const out = new Uint8ClampedArray(data);
  const s = Math.round(shift * px);
  for (let y = Math.round((50 - box[1]) * px); y < Math.round((229 - box[1]) * px); y++) {
    for (let x = 0; x < w; x++) {
      const from = x + s;
      out.set(from < w ? data.subarray((y * w + from) * 4, (y * w + from) * 4 + 4) : paper, (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data: out };
}

describe.skipIf(!session)('upload with IS-Net', () => {
  describe.each(TOOLS)('%s photo', (tool) => {
    const fx = presetFixture(tool);
    let r: UploadResult;
    let env: ReturnType<typeof modelEnv>;
    beforeAll(async () => {
      env = modelEnv();
      r = await upload(presetPhoto(tool), `  My ${tool}  `, deps, env);
    }, 60000);

    // The fixture outline comes from the stored preset mask (REGION crop); Python's own two-pass process_photo
    // lands up to 0.53 mm (minAreaRect side) and 0.6 mm (Hausdorff) from it on these photos, and this port
    // within 0.2 mm (sides) and 0.72 mm (Hausdorff) of process_photo. Hence 0.75 mm and 1.5 mm.
    it('traces an outline the size of the Python one (minAreaRect sides within 0.75 mm)', async () => {
      const [got, want] = [await rectDims(r.outline), await rectDims(fx.outline_mm)];
      expect(Math.abs(got[0] - want[0])).toBeLessThanOrEqual(0.75);
      expect(Math.abs(got[1] - want[1])).toBeLessThanOrEqual(0.75);
    });

    it('puts the tool where Python does on the sheet (Hausdorff within 1.5 mm)', () => {
      expect(hausdorff(apply(r.up2sheet, r.outline), apply(fx.up2sheet, fx.outline_mm))).toBeLessThanOrEqual(1.5);
    });

    it('scores symmetry like Python (within 0.03)', () => {
      expect(Math.abs(r.symmetry.score - fx.symmetry_score)).toBeLessThanOrEqual(0.03);
      expect(r.symmetry.outline.length).toBe(720);
    });

    it('returns the tool info and the sheet view at 4 px/mm', () => {
      expect(r.id).toMatch(/^up-[0-9a-f]{8}$/);
      expect(r.label).toBe(`My ${tool}`);
      expect(r.sym).toBe(false);
      expect(r.outline).toHaveLength(720);
      expect(r.sheetViewJpeg.type).toBe('image/jpeg');
      const [x0, y0, x1, y1] = r.sheetBox;
      expect(x0).toBeLessThanOrEqual(SHEET.markers[0]![0]![0]);
      expect(y1).toBeGreaterThanOrEqual(SHEET.markers[2]![2]![1]);
      const [view] = env.encoded;
      expect(Math.abs(view!.width - (x1 - x0) * 4)).toBeLessThanOrEqual(1);
      expect(Math.abs(view!.height - (y1 - y0) * 4)).toBeLessThanOrEqual(1);
    });
  });

  it('rejects a tool that runs off the edge of the photo', async () => {
    await rejects(upload(await shiftedSheet('stripper', 40), 'x', deps, modelEnv()), 'cut-off', /outside the photo/);
  }, 60000);
});
