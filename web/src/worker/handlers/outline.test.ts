import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initManifold } from '../../geometry/manifold';
import { hausdorff, presetFixture, TOOLS } from '../../test/fixtures';
import { DEFAULTS } from '../../params';
import type { Deps } from '../deps';
import type { PresetData, PresetSource } from '../presets';
import { PipelineError } from '../protocol';
import { outline } from './outline';

const readPublic = <T>(file: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/presets/${file}`, import.meta.url)), 'utf-8')) as T;

/** The committed public/presets files, read from disk. */
const diskPresets: PresetSource = {
  list: async () => readPublic<{ presets: { id: string; label: string; sym: boolean }[] }>('index.json').presets,
  get: async (id) => {
    if (!TOOLS.includes(id as never)) throw new PipelineError('unknown-tool', id);
    return readPublic<PresetData>(`${id}.json`);
  },
  url: (file) => `presets/${file}`,
};

let deps: Deps;
beforeAll(async () => {
  deps = { manifold: await initManifold(), presets: diskPresets };
});

describe.each(TOOLS)('outline handler: %s', (tool) => {
  const fx = presetFixture(tool);
  const params = { ...DEFAULTS, ...fx.params, tool };

  it('serves preset data that matches the parity fixture', async () => {
    const p = await diskPresets.get(tool);
    expect(p.outline_mm).toEqual(fx.outline_mm);
    expect(p.symmetric_outline_mm).toEqual(fx.symmetric_outline_mm);
    expect(p.up2sheet).toEqual(fx.up2sheet);
    expect(p.sym).toBe(fx.params.sym);
  });

  it('returns the fixture footprint and pocket, and maps them onto the sheet', async () => {
    const r = await outline(params, deps);
    expect([r.nx, r.ny]).toEqual(fx.footprint);
    expect(hausdorff(r.pocket, fx.pocket_mm)).toBeLessThanOrEqual(0.5);
    const [[a, b, c], [d, e, f]] = fx.up2sheet;
    const mapped = fx.pocket_mm.map(([x, y]) => [a * x + b * y + c, d * x + e * y + f] as [number, number]);
    expect(hausdorff(r.sheetPocket, mapped)).toBeLessThanOrEqual(0.5);
    expect(r.sheetImage).toBe(`presets/${tool}-sheet.jpg`);
    expect(r.effectiveDepth).toBe(fx.bin.effective_depth);
  });
});

describe('outline handler parameters', () => {
  it('keeps the sheet trace unrotated when the pocket is rotated', async () => {
    const a = await outline({ ...DEFAULTS, rot: 0 }, deps);
    const b = await outline({ ...DEFAULTS, rot: 45 }, deps);
    expect(b.sheetPocket).toEqual(a.sheetPocket);
    expect(b.nx).toBeGreaterThan(a.nx);
  });

  it('clamps out-of-range and non-numeric values', async () => {
    const r = await outline({ ...DEFAULTS, clearance: 99, slotFrac: Number.NaN, u: 30, depth: 500 }, deps);
    const ref = await outline({ ...DEFAULTS, clearance: 5, u: 8, depth: 46.05 }, deps);
    expect(r.pocket).toEqual(ref.pocket);
    expect(r.effectiveDepth).toBeCloseTo(46.05, 10);
    expect(r.maxDepth).toBeCloseTo(46.05, 10);
  });

  it('rejects unknown tools with a typed error', async () => {
    await expect(outline({ ...DEFAULTS, tool: 'nope' }, deps)).rejects.toMatchObject({ code: 'unknown-tool' });
  });
});
