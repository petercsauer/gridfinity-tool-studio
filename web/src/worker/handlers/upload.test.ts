import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initManifold } from '../../geometry/manifold';
import type { Ring, Vec2 } from '../../geometry/pocket';
import type { Part } from '../../kit';
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

/** A rectangle on the sheet: centre (mm), size [w, h] (mm) and angle (degrees). */
interface Blob2D {
  c: Vec2;
  size: [number, number];
  deg: number;
}

const MAGENTA = [255, 0, 255, 255] as const;

/** A flat, top-down "photo" of the stripper's sheet at 4 px/mm with `blobs` painted on it in magenta, cut off
 * by the photo's edge where they run past it. */
async function paintedSheet(blobs: readonly Blob2D[]): Promise<RGBAImage> {
  const px = 4;
  const { image, box } = await renderSheetView(presetPhoto('stripper'), sheetFixture('stripper').homography, [[[60, 80]]], px);
  const out = new Uint8ClampedArray(image.data);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const sx = box[0] + (x + 0.5) / px;
      const sy = box[1] + (y + 0.5) / px;
      const hit = blobs.some(({ c, size: [w, h], deg }) => {
        const t = (deg * Math.PI) / 180;
        const dx = sx - c[0], dy = sy - c[1];
        const u = dx * Math.cos(t) + dy * Math.sin(t);
        const v = -dx * Math.sin(t) + dy * Math.cos(t);
        return Math.abs(u) <= w / 2 && Math.abs(v) <= h / 2;
      });
      if (hit) out.set(MAGENTA, (y * image.width + x) * 4);
    }
  }
  return { ...image, data: out };
}

/** Segmentation that keys on the magenta paint (the real tool on the photo isn't magenta, so it's ignored). */
const magentaEnv: UploadEnv = {
  segment: async ({ width, height, data }) => {
    const m = new Uint8Array(width * height);
    for (let i = 0; i < m.length; i++) m[i] = data[i * 4]! > 200 && data[i * 4 + 1]! < 100 && data[i * 4 + 2]! > 200 ? 255 : 0;
    return { width, height, data: m };
  },
  encodeJpeg: async () => new Blob([], { type: 'image/jpeg' }),
};

/** The ring's cv.minAreaRect centre (mm). */
async function rectCentre(P: Ring): Promise<Vec2> {
  const cv = await getCv();
  const mat = cv.matFromArray(P.length, 1, cv.CV_32FC2, P.flat());
  try {
    const { center } = cv.minAreaRect(mat);
    return [center.x, center.y];
  } finally {
    mat.delete();
  }
}

describe('upload of a sheet with several parts', () => {
  // three parts in three rows: a box, then two thin antennas at an angle
  const KIT: Blob2D[] = [
    { c: [105, 80], size: [80, 40], deg: 10 },
    { c: [80, 150], size: [60, 10], deg: 35 },
    { c: [140, 200], size: [50, 12], deg: -70 },
  ];

  /** Expect the kit's parts to be `blobs`, in that order, traced to their size and place. */
  async function expectParts(r: UploadResult, blobs: readonly Blob2D[]): Promise<void> {
    expect(r.parts.map((q) => q.id)).toEqual(blobs.map((_, i) => `p${i + 1}`));
    for (const [i, b] of blobs.entries()) {
      const q = r.parts[i]!;
      const [short, long] = await rectDims(q.outline);
      expect(Math.abs(short - Math.min(...b.size)), `${q.id} short side`).toBeLessThanOrEqual(0.75);
      expect(Math.abs(long - Math.max(...b.size)), `${q.id} long side`).toBeLessThanOrEqual(0.75);
      const [c] = apply(q.up2sheet, [await rectCentre(q.outline)]);
      expect(Math.hypot(c![0] - b.c[0], c![1] - b.c[1]), `${q.id} centre`).toBeLessThanOrEqual(1);
      expect(q.outline).toHaveLength(720);
      expect(q.symmetry.outline).toHaveLength(720);
    }
  }

  it('traces each part on its own, numbered by position', async () => {
    const r = await upload(await paintedSheet(KIT), 'kit', deps, magentaEnv);
    await expectParts(r, KIT);
    // the sheet view covers every part
    const [x0, y0, x1, y1] = r.sheetBox;
    for (const q of r.parts) {
      for (const [x, y] of apply(q.up2sheet, q.outline)) {
        expect(x >= x0 && x <= x1 && y >= y0 && y <= y1).toBe(true);
      }
    }
  }, 120000);

  it('ignores a 6 x 6 mm speck', async () => {
    const r = await upload(await paintedSheet([...KIT, { c: [60, 110], size: [6, 6], deg: 0 }]), 'kit', deps, magentaEnv);
    await expectParts(r, KIT);
  }, 120000);

  it('rejects more than 12 parts', async () => {
    const grid = [60, 85, 110, 135, 160].flatMap((x) => [70, 100, 130].map((y): Blob2D => ({ c: [x, y], size: [15, 15], deg: 0 })));
    await rejects(upload(await paintedSheet(grid.slice(0, 13)), 'kit', deps, magentaEnv), 'too-many-parts', /13 parts/);
  }, 120000);

  it('names the part that runs off the photo', async () => {
    const kit = [KIT[0]!, { c: [20, 150], size: [60, 10], deg: 0 } satisfies Blob2D, KIT[2]!];
    await rejects(upload(await paintedSheet(kit), 'kit', deps, magentaEnv), 'cut-off', /^Part 2 runs off the photo/);
  }, 120000);
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
  const { image, box } = await renderSheetView(presetPhoto(tool), sheetFixture(tool).homography, [apply(fx.up2sheet, fx.outline_mm)], px);
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
    let part: Part;
    let env: ReturnType<typeof modelEnv>;
    beforeAll(async () => {
      env = modelEnv();
      r = await upload(presetPhoto(tool), `  My ${tool}  `, deps, env);
      part = r.parts[0]!;
    }, 60000);

    it('finds the one tool on the sheet', () => {
      expect(r.parts.map((q) => q.id)).toEqual(['p1']);
    });

    // The fixture outline comes from the stored preset mask (REGION crop); Python's own two-pass process_photo
    // lands up to 0.53 mm (minAreaRect side) and 0.6 mm (Hausdorff) from it on these photos, and this port
    // within 0.2 mm (sides) and 0.72 mm (Hausdorff) of process_photo. Hence 0.75 mm and 1.5 mm.
    it('traces an outline the size of the Python one (minAreaRect sides within 0.75 mm)', async () => {
      const [got, want] = [await rectDims(part.outline), await rectDims(fx.outline_mm)];
      expect(Math.abs(got[0] - want[0])).toBeLessThanOrEqual(0.75);
      expect(Math.abs(got[1] - want[1])).toBeLessThanOrEqual(0.75);
    });

    it('puts the tool where Python does on the sheet (Hausdorff within 1.5 mm)', () => {
      expect(hausdorff(apply(part.up2sheet, part.outline), apply(fx.up2sheet, fx.outline_mm))).toBeLessThanOrEqual(1.5);
    });

    it('scores symmetry like Python (within 0.03)', () => {
      expect(Math.abs(part.symmetry.score - fx.symmetry_score)).toBeLessThanOrEqual(0.03);
      expect(part.symmetry.outline.length).toBe(720);
    });

    it('returns the tool info and the sheet view at 4 px/mm', () => {
      expect(r.id).toMatch(/^up-[0-9a-f]{8}$/);
      expect(r.label).toBe(`My ${tool}`);
      expect(r.sym).toBe(false);
      expect(part.outline).toHaveLength(720);
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
