import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initManifold } from './manifold';
import { genbin, genbinManifold, liveObjects, type BinParams } from './bin';
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
