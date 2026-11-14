import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { initManifold } from './manifold';
import { genbin, genbinManifold, liveObjects, type BinParams, type PocketCut } from './bin';
import { bounds, maxDepth, type Ring } from './pocket';
import { presetFixture, TOOLS } from '../test/fixtures';
import { DEFAULTS } from '../params';
import { writeStl } from '../stl';
import { PipelineClient, type Port } from '../worker/client';
import { build } from '../worker/handlers/build';
import type { Deps } from '../worker/deps';
import type { PresetData, PresetSource } from '../worker/presets';
import { PipelineError, type Request, type Response } from '../worker/protocol';

let m: ManifoldToplevel;
beforeAll(async () => {
  m = await initManifold();
});

/** The fixture pocket centred on its bounding box, as genbin's callers pass it. */
function centred(P: Ring): Ring {
  const b = bounds(P);
  return P.map(([x, y]) => [x - (b.xmin + b.xmax) / 2, y - (b.ymin + b.ymax) / 2]);
}

/** Vertex count and volume of each fixture bin with bfillet 1 and both base holes, as cut before pockets had
 * their own depths (c5b57b8). */
/** Volumes (mm³) of each fixture's single-pocket bin (bottom round 1, every base hole) before the round-over
 * layers were simplified to 0.02 mm; the simplified bin stays within 0.005% of them (it moves under 0.002%, and losing half the bottom round would move it 0.02%). */
const UNSIMPLIFIED_VOLUME: Record<(typeof TOOLS)[number], number> = {
  needlenose: 223562.68481249735,
  combopliers: 344554.05245921994,
  flushcutter: 277182.377370868,
  stripper: 411199.66135931615,
};

describe.each(TOOLS)('bin parity: %s', (tool) => {
  const fx = presetFixture(tool);
  const [nx, ny] = fx.footprint;
  // the fixture's fillet is 3.175 (the browser slider snaps to 0.25 steps; pass it explicitly)
  const p: BinParams = { u: fx.params.u, depth: fx.params.depth, fillet: fx.params.fillet, bfillet: fx.params.bfillet };

  it('is a valid single closed solid', () => {
    const { bin } = genbinManifold(m, centred(fx.pocket_mm), nx, ny, p);
    try {
      expect(bin.status()).toBe('NoError');
      expect(bin.genus()).toBe(0);
      const parts = bin.decompose();
      expect(parts.length).toBe(1);
      parts.forEach((x) => x.delete());
    } finally {
      bin.delete();
    }
  });

  it('matches the Python volume (1%), bbox (0.05 mm) and effective depth', () => {
    const r = genbin(m, centred(fx.pocket_mm), nx, ny, p);
    expect(Math.abs(r.volume - fx.bin.volume_mm3) / fx.bin.volume_mm3).toBeLessThan(0.01);
    const [lo, hi] = fx.bin.bbox;
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(r.bbox.min[k]! - lo[k]!)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(r.bbox.max[k]! - hi[k]!)).toBeLessThanOrEqual(0.05);
    }
    expect(r.effectiveDepth).toBeCloseTo(fx.bin.effective_depth, 4);
    expect([r.nx, r.ny]).toEqual(fx.footprint);
  });

  it('cuts one pocket with its own depth exactly as a single pocket at the bin depth', () => {
    // with a bottom round and every base hole, where one batch difference would change the mesh
    const q = { ...p, bfillet: 1, holes: 'both' as const };
    const r = genbin(m, [{ ring: centred(fx.pocket_mm), depth: p.depth }], nx, ny, { ...q, depth: 0 });
    const plain = genbin(m, centred(fx.pocket_mm), nx, ny, q);
    expect(r.positions).toEqual(plain.positions);
    expect(r.indices).toEqual(plain.indices);
    expect(Math.abs(r.volume - UNSIMPLIFIED_VOLUME[tool]) / UNSIMPLIFIED_VOLUME[tool]).toBeLessThan(5e-5);
    expect(r.effectiveDepths).toHaveLength(1);
    expect(r.effectiveDepths[0]).toBeCloseTo(Math.min(p.depth, maxDepth(p.u, { holes: 'both' })), 9);
  });
});

describe('several pockets', () => {
  const rect = (x0: number, y0: number, w: number, h: number): Ring => [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];
  const p: BinParams = { u: 4, depth: 12, fillet: 2, bfillet: 0.5 };
  const volume = (pockets: Ring[]) => genbin(m, pockets, 3, 2, p).volume;

  it('cuts one ring and a list of that one ring identically', () => {
    const fx = presetFixture('needlenose');
    const ring = centred(fx.pocket_mm);
    const a = genbin(m, ring, fx.footprint[0], fx.footprint[1], { ...p, fillet: 3.175 });
    const b = genbin(m, [ring], fx.footprint[0], fx.footprint[1], { ...p, fillet: 3.175 });
    expect(b.volume).toBe(a.volume);
    expect(b.indices.length).toBe(a.indices.length);
    expect(b.positions).toEqual(a.positions);
  });

  it('cuts disjoint pockets independently: removals add up', () => {
    const A = rect(-50, -20, 30, 40);
    const B = rect(10, -15, 40, 20);
    const none = volume([]);
    const removed = (pockets: Ring[]) => none - volume(pockets);
    expect(removed([A, B])).toBeCloseTo(removed([A]) + removed([B]), 0);
    const { bin } = genbinManifold(m, [A, B], 3, 2, p);
    try {
      expect(bin.status()).toBe('NoError');
      expect(bin.genus()).toBe(0);
    } finally {
      bin.delete();
    }
    expect(liveObjects()).toBe(0);
  });

  it('merges overlapping pockets into one', () => {
    const A = rect(-40, -15, 50, 30);
    const B = rect(0, -15, 40, 30);
    expect(volume([A, B])).toBeCloseTo(volume([rect(-40, -15, 80, 30)]), 0);
    expect(liveObjects()).toBe(0);
  });
});

describe('pockets at their own depths', () => {
  const rect = (x0: number, y0: number, w: number, h: number): Ring => [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];
  /** Area of the bin's cross-section at height z (the final vertex merge shifts it by under 0.1 mm²). */
  const sliceArea = (bin: Manifold, z: number) => {
    const cs = bin.slice(z);
    try {
      return cs.area();
    } finally {
      cs.delete();
    }
  };
  /** Builds the bin and passes it to `check`, then frees it. */
  const withBin = <T>(cuts: PocketCut[], nx: number, ny: number, p: BinParams, check: (b: ReturnType<typeof genbinManifold>) => T): T => {
    const r = genbinManifold(m, cuts, nx, ny, p);
    try {
      return check(r);
    } finally {
      r.bin.delete();
    }
  };

  it('cuts two disjoint pockets 10 and 25 mm deep, each to its own floor', () => {
    // 5U: the shortest bin a 25 mm pocket fits in (4U holds 18 mm)
    const p: BinParams = { u: 5, depth: 0, fillet: 1, bfillet: 0.5 };
    const recessZ = 5 * 7 - 4.4;
    const shallow = rect(-30, -10, 20, 20);
    const deep = rect(10, -10, 20, 20);
    const empty = withBin([], 2, 1, p, ({ bin }) => sliceArea(bin, recessZ - 15));
    withBin([{ ring: shallow, depth: 10 }, { ring: deep, depth: 25 }], 2, 1, p, ({ bin, effectiveDepths, effectiveDepth }) => {
      expect(effectiveDepths).toEqual([10, 25]);
      expect(effectiveDepth).toBe(25);
      expect(bin.status()).toBe('NoError');
      expect(bin.genus()).toBe(0);
      // 15 mm down only the deep pocket is open
      expect(empty - sliceArea(bin, recessZ - 15)).toBeCloseTo(400, 0);
      expect(empty - sliceArea(bin, recessZ - 5)).toBeCloseTo(800, 0);
    });
    expect(liveObjects()).toBe(0);
  });

  it('gives overlapping pockets of different depths the deeper floor where they overlap', () => {
    const p: BinParams = { u: 4, depth: 0, fillet: 1, bfillet: 0.5 };
    const recessZ = 4 * 7 - 4.4;
    const A = rect(-30, -10, 40, 20);
    const B = rect(0, -10, 30, 20);
    const empty = withBin([], 2, 1, p, ({ bin }) => sliceArea(bin, recessZ - 10));
    const emptyTop = withBin([], 2, 1, p, ({ bin }) => sliceArea(bin, recessZ - 3));
    withBin([{ ring: A, depth: 6 }, { ring: B, depth: 15 }], 2, 1, p, ({ bin, effectiveDepths }) => {
      expect(effectiveDepths).toEqual([6, 15]);
      expect(bin.status()).toBe('NoError');
      expect(bin.genus()).toBe(0);
      const parts = bin.decompose();
      expect(parts.length).toBe(1);
      parts.forEach((x) => x.delete());
      // below A's floor, all of B (overlap included) is open; above it, both
      expect(empty - sliceArea(bin, recessZ - 10)).toBeCloseTo(30 * 20, 0);
      expect(emptyTop - sliceArea(bin, recessZ - 3)).toBeCloseTo(60 * 20, 0);
    });
    expect(liveObjects()).toBe(0);
  });

  it('clamps each depth to what the bin holds', () => {
    const p: BinParams = { u: 3, depth: 0, fillet: 0, bfillet: 0 };
    withBin([{ ring: rect(-15, -10, 10, 20), depth: 4 }, { ring: rect(5, -10, 10, 20), depth: 40 }], 1, 1, p, (r) => {
      expect(r.effectiveDepths).toEqual([4, maxDepth(3)]);
      expect(r.effectiveDepth).toBeCloseTo(maxDepth(3), 9);
    });
  });
});

describe('bin edge cases', () => {
  const fx = presetFixture('needlenose');
  const pocket = centred(fx.pocket_mm);
  const [nx, ny] = fx.footprint;

  it('1U (no room for a pocket) cuts nothing and stays valid', () => {
    const { bin, effectiveDepth } = genbinManifold(m, pocket, nx, ny, { u: 1, depth: 10, fillet: 3.175, bfillet: 0 });
    try {
      expect(bin.status()).toBe('NoError');
      expect(effectiveDepth).toBe(0);
    } finally {
      bin.delete();
    }
  });

  it.each([
    ['deeper than the bin allows', { u: 3, depth: 40, fillet: 3.175, bfillet: 0 }],
    ['bottom round', { u: 4, depth: 12, fillet: 2, bfillet: 2 }],
    ['no round-overs', { u: 3, depth: 10, fillet: 0, bfillet: 0 }],
  ])('%s stays a valid solid with the effective depth capped', (_name, p) => {
    const { bin, effectiveDepth } = genbinManifold(m, pocket, nx, ny, p);
    try {
      expect(bin.status()).toBe('NoError');
      expect(bin.genus()).toBe(0);
      expect(effectiveDepth).toBeLessThanOrEqual(maxDepth(p.u) + 1e-9);
      expect(effectiveDepth).toBeCloseTo(Math.min(p.depth, maxDepth(p.u)), 6);
    } finally {
      bin.delete();
    }
  });

  it('frees every manifold object across 50 builds', () => {
    // a small 1x1 bin keeps this quick; every code path (both round-overs) still runs
    const disc: Ring = Array.from({ length: 64 }, (_, k) => [10 * Math.cos((k * Math.PI) / 32), 6 * Math.sin((k * Math.PI) / 32)]);
    for (let i = 0; i < 50; i++) {
      genbin(m, disc, 1, 1, { u: 3, depth: 6 + (i % 5), fillet: 1.5, bfillet: 0.5 });
      expect(liveObjects()).toBe(0);
    }
  });
});

describe('base options', () => {
  // a 1x1 bin with a small pocket keeps these quick
  const disc: Ring = Array.from({ length: 64 }, (_, k) => [8 * Math.cos((k * Math.PI) / 32), 5 * Math.sin((k * Math.PI) / 32)]);
  const base: BinParams = { u: 3, depth: 6, fillet: 1, bfillet: 0 };
  const volume = (p: BinParams, nx = 1, ny = 1) => {
    const { bin } = genbinManifold(m, disc, nx, ny, p);
    try {
      expect(bin.status()).toBe('NoError');
      const parts = bin.decompose();
      expect(parts.length).toBe(1);
      parts.forEach((x) => x.delete());
      return bin.volume();
    } finally {
      bin.delete();
    }
  };
  const cyl = (d: number, h: number) => Math.PI * (d / 2) ** 2 * h;
  let v0 = 0;
  beforeAll(() => {
    v0 = volume(base);
  });

  it.each([
    ['magnet', cyl(6.5, 2.4)],
    ['screw', cyl(3, 6)],
    ['both', cyl(6.5, 2.4) + cyl(3, 6 - 2.4)],
  ] as const)('%s holes remove four holes per cell', (holes, each) => {
    // polygonal cylinders are slightly smaller than true ones: allow 1.5%
    expect((v0 - volume({ ...base, holes })) / (4 * each)).toBeCloseTo(1, 1);
    expect(liveObjects()).toBe(0);
  });

  it('corners only puts holes at the four outer corners of a 2x2 bin', () => {
    const all = volume({ ...base, holes: 'magnet' }, 2, 2);
    const corners = volume({ ...base, holes: 'magnet', holesCorners: true }, 2, 2);
    const none = volume(base, 2, 2);
    expect((none - all) / (none - corners)).toBeCloseTo(4, 1); // 16 holes against 4
  });

  it('without the lip the top is flat at the bin height and the pocket can go 4.4 mm deeper', () => {
    const p: BinParams = { ...base, depth: 40, lip: false };
    const r = genbin(m, disc, 1, 1, p);
    expect(r.bbox.max[2]).toBeCloseTo(21, 3);
    expect(r.effectiveDepth).toBeCloseTo(maxDepth(3, { lip: true }) + 4.4, 6);
    expect(r.effectiveDepth).toBeCloseTo(maxDepth(3, p), 6);
  });

  it('screw holes raise the pocket floor so the pocket never breaks into them', () => {
    const p: BinParams = { ...base, depth: 40, holes: 'screw' };
    const r = genbin(m, disc, 1, 1, p);
    expect(r.effectiveDepth).toBeCloseTo(21 - 4.4 - (6 + 0.8), 6);
    expect(r.effectiveDepth).toBeCloseTo(maxDepth(3, p), 6);
    expect(maxDepth(3, { holes: 'magnet' })).toBeCloseTo(maxDepth(3), 6); // magnets fit under the usual floor
  });
});

describe('STL writer', () => {
  it('writes one 50-byte record per triangle, Z up, with the mesh vertices', () => {
    const fx = presetFixture('flushcutter');
    const r = genbin(m, centred(fx.pocket_mm), fx.footprint[0], fx.footprint[1], { ...fx.params });
    const buf = writeStl(r.positions, r.indices);
    const dv = new DataView(buf);
    const n = dv.getUint32(80, true);
    expect(n).toBe(r.indices.length / 3);
    expect(buf.byteLength).toBe(84 + 50 * n);
    let zmax = -Infinity;
    for (let t = 0; t < n; t++) {
      const o = 84 + 50 * t;
      const len = Math.hypot(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true));
      expect(Math.abs(len - 1)).toBeLessThan(1e-3);
      for (let k = 0; k < 3; k++) {
        const v = r.indices[t * 3 + k]! * 3;
        for (let c = 0; c < 3; c++) expect(dv.getFloat32(o + 12 + 12 * k + 4 * c, true)).toBe(r.positions[v + c]);
        zmax = Math.max(zmax, dv.getFloat32(o + 12 + 12 * k + 8, true));
      }
    }
    expect(zmax).toBeCloseTo(fx.bin.bbox[1][2], 3);
  });
});

/** The fixture tools in the app's preset format (tests/fixtures/web-presets, written by build_presets.py). */
const readPublic = <T>(file: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/web-presets/${file}`, import.meta.url)), 'utf-8')) as T;
const diskPresets: PresetSource = {
  list: async () => readPublic<{ presets: { id: string; label: string; sym: boolean }[] }>('index.json').presets,
  get: async (id) => {
    if (!TOOLS.includes(id as never)) throw new PipelineError('unknown-tool', id);
    return readPublic<PresetData>(`${id}.json`);
  },
  url: (file) => `presets/${file}`,
};

describe('build handler', () => {
  let deps: Deps;
  beforeAll(() => {
    deps = { manifold: m, presets: diskPresets };
  });

  it.each(TOOLS)('builds the %s fixture bin from its preset', async (tool) => {
    const fx = presetFixture(tool);
    const r = await build({ ...DEFAULTS, ...fx.params, tool }, deps);
    expect([r.nx, r.ny]).toEqual(fx.footprint);
    expect(r.effectiveDepth).toBeCloseTo(fx.bin.effective_depth, 4);
    let zmin = Infinity, zmax = -Infinity;
    for (let i = 2; i < r.positions.length; i += 3) {
      zmin = Math.min(zmin, r.positions[i]!);
      zmax = Math.max(zmax, r.positions[i]!);
    }
    expect(zmin).toBeCloseTo(fx.bin.bbox[0][2], 3);
    expect(zmax).toBeCloseTo(fx.bin.bbox[1][2], 3);
    expect(r.indices.length % 3).toBe(0);
  });

  it('refuses a footprint over the size limit', async () => {
    const huge = await diskPresets.get('needlenose');
    const scaled = (P: Ring): Ring => P.map(([x, y]) => [x * 2, y * 2]);
    const big: Deps = {
      manifold: m,
      presets: { ...diskPresets, get: async () => ({ ...huge, outline_mm: scaled(huge.outline_mm), symmetric_outline_mm: scaled(huge.symmetric_outline_mm) }) },
    };
    await expect(build({ ...DEFAULTS, tool: 'needlenose' }, big)).rejects.toMatchObject({ code: 'too-large' });
  });
});

describe('slider race', () => {
  it('keeps only the newest of several in-flight builds', async () => {
    const sent: Request[] = [];
    let listener: (e: MessageEvent) => void = () => {};
    const port: Port = {
      postMessage: (msg) => { sent.push(msg as Request); },
      addEventListener: (_t, l) => { listener = l; },
    };
    const reply = (res: Response) => listener({ data: res } as MessageEvent);
    const c = new PipelineClient(port);
    const builds = [10, 8, 6].map((depth) => c.request('build', { params: { ...DEFAULTS, depth } }));
    const mesh = (d: number) => ({ positions: new Float32Array([d]), indices: new Uint32Array(), effectiveDepth: d, nx: 2, ny: 5 });
    // answers arrive out of order: newest first, then the two stale ones
    for (const k of [2, 0, 1]) {
      const q = sent[k] as Request<'build'>;
      reply({ id: q.id, kind: 'build', version: q.version, ok: true, result: mesh(q.params.depth) });
    }
    const [a, b, latest] = await Promise.all(builds);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(latest?.effectiveDepth).toBe(6);
    expect(c.isCurrent('build', (sent[2] as Request<'build'>).version)).toBe(true);
  });
});

describe('half-grid feet', () => {
  const disc: Ring = Array.from({ length: 64 }, (_, k) => [8 * Math.cos((k * Math.PI) / 32), 5 * Math.sin((k * Math.PI) / 32)]);
  const base: BinParams = { u: 3, depth: 6, fillet: 1, bfillet: 0, halfGrid: true };
  /** Checks the bin is one valid solid; returns its feet (the parts below 4.7 mm), size and volume. */
  const feet = (p: BinParams, nx: number, ny: number) => {
    const { bin } = genbinManifold(m, disc, nx, ny, p);
    try {
      expect(bin.status()).toBe('NoError');
      expect(bin.genus()).toBe(0);
      const parts = bin.decompose();
      expect(parts.length).toBe(1);
      parts.forEach((x) => x.delete());
      const low = bin.trimByPlane([0, 0, -1], -4.7);
      const pads = low.decompose();
      const boxes = pads.map((x) => x.boundingBox());
      pads.forEach((x) => x.delete());
      low.delete();
      const box = bin.boundingBox();
      return { count: pads.length, boxes, volume: bin.volume(), size: [box.max[0] - box.min[0], box.max[1] - box.min[1]] };
    } finally {
      bin.delete();
    }
  };

  it.each([
    [1.5, 2, 12],
    [0.5, 1, 2],
    [1, 1, 4],
    [2.5, 1.5, 15],
  ])('a %s x %s bin is one valid solid with a foot per 21 mm half cell (%s feet)', (nx, ny, n) => {
    const r = feet(base, nx, ny);
    expect(r.count).toBe(n);
    expect(r.size[0]).toBeCloseTo(42 * nx - 0.5, 3);
    expect(r.size[1]).toBeCloseTo(42 * ny - 0.5, 3);
    for (const b of r.boxes) {
      // just under the 20.5 mm pad top (the cut is 0.05 mm below it)
      expect(b.max[0] - b.min[0]).toBeGreaterThan(20.3);
      expect(b.max[0] - b.min[0]).toBeLessThan(20.5);
      expect(b.min[2]).toBeCloseTo(0, 6);
    }
    expect(liveObjects()).toBe(0);
  });

  it('puts four half-grid feet where a full-grid bin has one, same outer size, less material', () => {
    const half = feet(base, 2, 1);
    const full = feet({ ...base, halfGrid: false }, 2, 1);
    expect(full.count).toBe(2);
    expect(half.count).toBe(8);
    expect(half.size[0]).toBeCloseTo(full.size[0]!, 6);
    expect(half.size[1]).toBeCloseTo(full.size[1]!, 6);
    expect(half.volume).toBeLessThan(full.volume);
  });

  it('cuts no base holes and keeps the usual pocket floor', () => {
    const plain = feet(base, 1.5, 1);
    for (const holes of ['magnet', 'screw', 'both'] as const) {
      expect(feet({ ...base, holes, holesCorners: true }, 1.5, 1).volume).toBeCloseTo(plain.volume, 3);
      expect(feet({ ...base, holes }, 1.5, 1).volume).toBeCloseTo(plain.volume, 3);
    }
    const deep = genbin(m, disc, 1.5, 1, { ...base, depth: 40, holes: 'screw' });
    expect(deep.effectiveDepth).toBeCloseTo(maxDepth(3), 6);
  });

  it('refuses half cells without half-grid feet', () => {
    expect(() => genbinManifold(m, disc, 1.5, 1, { ...base, halfGrid: false })).toThrow(/whole/);
    expect(liveObjects()).toBe(0);
  });

  it('is sized and built by the build handler', async () => {
    const deps: Deps = { manifold: m, presets: diskPresets };
    const fx = presetFixture('needlenose');
    const params = { ...DEFAULTS, ...fx.params, tool: 'needlenose' };
    const whole = await build(params, deps);
    const half = await build({ ...params, halfGrid: true }, deps);
    expect(Number.isInteger(whole.nx) && Number.isInteger(whole.ny)).toBe(true);
    expect(Number.isInteger(half.nx * 2) && Number.isInteger(half.ny * 2)).toBe(true);
    expect(half.nx).toBeLessThanOrEqual(whole.nx);
    expect(half.ny).toBeLessThanOrEqual(whole.ny);
    expect(half.nx).toBeGreaterThan(whole.nx - 1);
    expect(half.ny).toBeGreaterThan(whole.ny - 1);
  });

  it('refuses a half-grid footprint over 16 half cells', async () => {
    const huge = await diskPresets.get('needlenose');
    const scaled = (P: Ring): Ring => P.map(([x, y]) => [x * 2.2, y * 2.2]);
    const big: Deps = {
      manifold: m,
      presets: { ...diskPresets, get: async () => ({ ...huge, outline_mm: scaled(huge.outline_mm), symmetric_outline_mm: scaled(huge.symmetric_outline_mm) }) },
    };
    await expect(build({ ...DEFAULTS, tool: 'needlenose', halfGrid: true }, big)).rejects.toMatchObject({ code: 'too-large' });
  });
});
