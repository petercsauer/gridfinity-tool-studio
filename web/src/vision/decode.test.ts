import { describe, expect, it, vi } from 'vitest';
import { PipelineError } from '../worker/protocol';
import { decodePhoto, fitSize, isHeic, MAX_SIDE, type DecodeEnv } from './decode';

describe('fitSize', () => {
  it('keeps photos within the long-side limit and never upscales', () => {
    expect(fitSize(1176, 1568)).toEqual([1176, 1568]);
    expect(fitSize(8064, 6048)).toEqual([MAX_SIDE, 3000]);
    expect(fitSize(3000, 9000)).toEqual([1333, MAX_SIDE]);
  });
});

describe('isHeic', () => {
  it('recognises HEIC/HEIF by type or extension', () => {
    expect(isHeic('image/heic', '')).toBe(true);
    expect(isHeic('image/heif-sequence', 'x')).toBe(true);
    expect(isHeic('', 'IMG_0001.HEIC')).toBe(true);
    expect(isHeic('image/jpeg', 'a.jpg')).toBe(false);
  });
});

function bitmap(width: number, height: number) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

function env(over: Partial<DecodeEnv>): DecodeEnv {
  return {
    createImageBitmap: async () => bitmap(10, 10),
    heicToJpeg: async () => { throw new Error('unexpected'); },
    rasterize: (_b, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) as ImageData,
    ...over,
  };
}

describe('decodePhoto', () => {
  it('downscales large photos and closes the bitmap', async () => {
    const bm = bitmap(6000, 4500);
    const out = await decodePhoto(new Blob([]), 'a.jpg', env({ createImageBitmap: async () => bm }));
    expect([out.width, out.height]).toEqual([4000, 3000]);
    expect(bm.close).toHaveBeenCalled();
  });

  it('converts HEIC the browser cannot decode', async () => {
    const jpeg = new Blob(['jpeg'], { type: 'image/jpeg' });
    const heicToJpeg = vi.fn(async () => jpeg);
    const createImageBitmap = vi.fn(async (b: Blob) => { if (b !== jpeg) throw new Error('no heic'); return bitmap(30, 20); });
    const out = await decodePhoto(new Blob(['x']), 'IMG_1.heic', env({ createImageBitmap, heicToJpeg }));
    expect(heicToJpeg).toHaveBeenCalledOnce();
    expect([out.width, out.height]).toEqual([30, 20]);
  });

  it('reports unreadable files and failed HEIC conversions', async () => {
    const fail = async () => { throw new Error('bad'); };
    const e1 = await decodePhoto(new Blob(['x'], { type: 'text/plain' }), 'a.txt', env({ createImageBitmap: fail })).catch((e) => e);
    expect(e1).toBeInstanceOf(PipelineError);
    expect(e1.message).toMatch(/could not be read as an image/);
    const e2 = await decodePhoto(new Blob(['x'], { type: 'image/heic' }), '', env({ createImageBitmap: fail, heicToJpeg: fail })).catch((e) => e);
    expect(e2.message).toMatch(/HEIC photo could not be converted/);
  });
});
