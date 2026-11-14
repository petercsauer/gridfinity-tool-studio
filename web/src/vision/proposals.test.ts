import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { paperBlobs } from './proposals';
import { rectRegion, type Box, type Homography } from './sheet';
import { presetPhoto } from './test-images';

const homography = (tool: string) =>
  (JSON.parse(readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/presets/${tool}.json`, import.meta.url)), 'utf-8')) as
    { homography: Homography }).homography;

const PX = 8;
const R1: Box = [-40, -40, 255.9, 337];
const area = ([x0, y0, x1, y1]: Box) => (x1 - x0) * (y1 - y0);
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

describe('paperBlobs', () => {
  it('finds the tool and a small dark part on the paper, and none of the print', async () => {
    const { canvas } = await rectRegion(presetPhoto('stripper'), homography('stripper'), R1, PX);
    const alone = (await paperBlobs(canvas, [R1[0], R1[1]], PX)).map((b) => b.box);
    // a dark 45 x 9 mm bar (an antenna) on empty paper, at the sheet's top right
    const bar: Box = [140, 70, 185, 79];
    const data = new Uint8ClampedArray(canvas.data);
    for (let y = Math.round((bar[1] - R1[1]) * PX); y < (bar[3] - R1[1]) * PX; y++) {
      for (let x = Math.round((bar[0] - R1[0]) * PX); x < (bar[2] - R1[0]) * PX; x++) data.set([30, 30, 32, 255], (y * canvas.width + x) * 4);
    }
    const blobs = await paperBlobs({ ...canvas, data }, [R1[0], R1[1]], PX);
    const found = blobs.map((b) => b.box);
    expect(found).toHaveLength(alone.length + 1);
    // the new blob (the stripper lies diagonally, so its own box covers the bar too)
    const hit = found.find((b) => !alone.some((a) => a.join() === b.join()))!;
    expect(overlap(hit, bar)).toBeGreaterThan(0.8 * area(bar));
    expect(hit).toBeDefined();
    expect(area(hit)).toBeLessThan(1.5 * area(bar));
    // its deepest point is on the bar
    const { inner: [ix, iy] } = blobs[found.indexOf(hit)]!;
    expect(ix > bar[0] && ix < bar[2] && iy > bar[1] && iy < bar[3]).toBe(true);
    // without the bar: only the stripper itself, one blob (the grid, rulers and text are thinner than the print filter)
    expect(alone.length).toBeLessThanOrEqual(1);
  });

  it.each(['stripper', 'combopliers', 'needlenose', 'flushcutter'])('finds no new blobs on the %s photo under a warm colour cast', async (tool) => {
    const { canvas } = await rectRegion(presetPhoto(tool), homography(tool), R1, PX);
    const plain = (await paperBlobs(canvas, [R1[0], R1[1]], PX)).map((b) => b.box);
    // tungsten light the camera didn't correct: green at 83%, blue at 66%
    const data = new Uint8ClampedArray(canvas.data);
    for (let i = 0; i < data.length; i += 4) {
      data[i + 1] = data[i + 1]! * 0.83;
      data[i + 2] = data[i + 2]! * 0.66;
    }
    // no phantoms on the paper, print or corners: at most the blobs it finds without the cast, each on one of them
    // (the cast dulls a coloured handle, which the model finds anyway)
    const tinted = (await paperBlobs({ ...canvas, data }, [R1[0], R1[1]], PX)).map((b) => b.box);
    expect(tinted.length).toBeLessThanOrEqual(plain.length);
    for (const b of tinted) expect(plain.some((q) => overlap(b, q) > 0)).toBe(true);
  });
});
