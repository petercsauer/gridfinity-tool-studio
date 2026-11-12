import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { TOOLS } from '../test/fixtures';
import {
  applyHomography, detectMarkers, detectSheet, MARKER_IDS, missingMarkers, rectRegion, renderSheetView, SHEET,
  SheetError, type Corners, type Homography, type Point, type RGBAImage,
} from './sheet';
import { blankOut, presetPhoto, presetRect, solid } from './test-images';

const ROOT = new URL('../../../', import.meta.url);
const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, ROOT)), 'utf-8'));

interface SheetFixture { marker_corners_px: Record<string, Corners>; homography: Homography }

describe('sheet metadata', () => {
  it('matches assets/sheet/sheet_markers.json', () => {
    const meta = read('assets/sheet/sheet_markers.json');
    expect(meta.dict).toBe('DICT_4X4_50');
    expect(SHEET.pageMm).toEqual(meta.pages.letter);
    expect(SHEET.markerEdgeMm).toBe(meta.marker_edge_mm);
    expect(Object.fromEntries(Object.entries(SHEET.markers))).toEqual(meta.markers);
    expect(MARKER_IDS).toEqual([0, 1, 2, 3]);
  });
});

describe.each(TOOLS)('%s photo', (tool) => {
  const fx = read(`tests/fixtures/presets/${tool}.json`) as SheetFixture;
  let img: RGBAImage;
  beforeAll(() => { img = presetPhoto(tool); });

  it('detects all four markers within 1.5 px of the Python corners', async () => {
    const found = await detectMarkers(img);
    expect([...found.keys()].sort()).toEqual([0, 1, 2, 3]);
    for (const [id, want] of Object.entries(fx.marker_corners_px)) {
      const got = found.get(Number(id))!;
      want.forEach((p, j) => expect(Math.hypot(got[j]![0] - p[0], got[j]![1] - p[1])).toBeLessThanOrEqual(1.5));
    }
  });

  it('maps the fixture corners to the same sheet mm as the Python homography, within 0.2 mm', async () => {
    const { H } = await detectSheet(img);
    for (const [id, px] of Object.entries(fx.marker_corners_px)) {
      px.forEach((p, j) => {
        const [q, r] = [applyHomography(H, p), applyHomography(fx.homography, p)];
        expect(Math.hypot(q[0] - r[0], q[1] - r[1])).toBeLessThanOrEqual(0.2);
        // integer-pixel corners leave the fit itself about 0.5 mm off the nominal positions (Python too)
        const want = SHEET.markers[Number(id)]![j]!;
        expect(Math.hypot(q[0] - want[0], q[1] - want[1])).toBeLessThanOrEqual(0.6);
      });
    }
  });

  it('rectifies the working area like the Python reference', async () => {
    const { H } = await detectSheet(img);
    const { canvas } = await rectRegion(img, H, [14, 56, 201, 226]);
    const ref = presetRect(tool);
    expect([canvas.width, canvas.height]).toEqual([ref.width, ref.height]);
    let sum = 0;
    for (let i = 0; i < ref.width * ref.height * 4; i++) if (i % 4 !== 3) sum += Math.abs(canvas.data[i]! - ref.data[i]!);
    expect(sum / (ref.width * ref.height * 3)).toBeLessThan(3);   // mean level difference; JPEG decoders differ by ~1
  });
});

describe('rejection', () => {
  it('names the missing marker when one is covered', async () => {
    const fx = read('tests/fixtures/presets/stripper.json') as SheetFixture;
    const img = blankOut(presetPhoto('stripper'), fx.marker_corners_px['2']!, 25);
    expect(missingMarkers(await detectMarkers(img))).toEqual([2]);
    const err = await detectSheet(img).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SheetError);
    expect((err as SheetError).code).toBe('invalid');
    expect((err as SheetError).missing).toEqual([2]);
    expect((err as SheetError).message).toBe('No calibration sheet detected (found 3 of 4 markers; missing 2). '
      + 'Photograph the tool on the printed calibration sheet with all four corner markers visible and not covered by the tool.');
  });

  it('rejects an image without a sheet', async () => {
    const err = await detectSheet(solid(640, 480, [120, 160, 90])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SheetError);
    expect((err as SheetError).missing).toEqual([0, 1, 2, 3]);
    expect((err as SheetError).message).toContain('found 0 of 4 markers; missing 0, 1, 2, 3');
  });
});

describe('rectification', () => {
  let img: RGBAImage;
  let H: Homography;
  beforeAll(async () => { img = presetPhoto('needlenose'); ({ H } = await detectSheet(img)); });

  it('warps a region at 8 px/mm, whites out the markers and marks pixels outside the photo invalid', async () => {
    const [pw, ph] = SHEET.pageMm;
    const region = [-40, -40, pw + 40, ph + 40] as [number, number, number, number];
    const { canvas, valid } = await rectRegion(img, H, region);
    expect([canvas.width, canvas.height]).toEqual([Math.trunc((pw + 80) * 8), Math.trunc((ph + 80) * 8)]);
    expect(valid.length).toBe(canvas.width * canvas.height);
    const at = (xMm: number, yMm: number) => {
      const i = Math.trunc((yMm + 40) * 8) * canvas.width + Math.trunc((xMm + 40) * 8);
      return { rgba: [...canvas.data.subarray(i * 4, i * 4 + 4)], valid: valid[i] };
    };
    expect(at(30, 34)).toEqual({ rgba: [235, 235, 235, 255], valid: 255 });   // marker 0 centre
    expect(at(-39, -39)).toEqual({ rgba: [0, 0, 0, 255], valid: 0 });          // off the photo
    const paper = at(108, 140);                                                // blank paper mid-sheet
    expect(paper.valid).toBe(255);
    expect(Math.min(...paper.rgba.slice(0, 3))).toBeGreaterThan(120);
  });

  it('renders the sheet view around the markers, widened for a tool past the paper', async () => {
    const m = 0.18 * 24 + 3;
    const inside: Point[] = [[60, 80], [150, 200]];
    const a = await renderSheetView(img, H, inside);
    expect(a.box).toEqual([18 - m, 22 - m, 197.9 + m, 257.4 + m].map((v) => Math.round(v * 100) / 100));
    expect([a.image.width, a.image.height]).toEqual([Math.trunc((197.9 - 18 + 2 * m) * 4), Math.trunc((257.4 - 22 + 2 * m) * 4)]);
    const b = await renderSheetView(img, H, [...inside, [230, 120]]);
    expect(b.box[2]).toBe(236);
    expect(b.box.slice(0, 2)).toEqual(a.box.slice(0, 2));
  });
});
