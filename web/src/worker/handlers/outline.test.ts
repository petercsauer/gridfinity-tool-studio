import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initManifold } from '../../geometry/manifold';
import { bounds, makePocket } from '../../geometry/pocket';
import { hausdorff, presetFixture, TOOLS } from '../../test/fixtures';
import { DEFAULTS } from '../../params';
import type { Deps } from '../deps';
import { withUploads, type PresetData, type PresetSource } from '../presets';
import { PipelineError } from '../protocol';
import { outline } from './outline';

const readPublic = <T>(file: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../tests/fixtures/web-presets/${file}`, import.meta.url)), 'utf-8')) as T;

/** The fixture tools in the app's preset format (tests/fixtures/web-presets, written by build_presets.py). */
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

/** The defaults these tests were written against (the needle-nose preset, symmetric). */
const NEEDLENOSE = { ...DEFAULTS, tool: 'needlenose', sym: true };

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
    const a = await outline({ ...NEEDLENOSE, rot: 0 }, deps);
    const b = await outline({ ...NEEDLENOSE, rot: 45 }, deps);
    expect(b.sheetPocket).toEqual(a.sheetPocket);
    expect(b.nx).toBeGreaterThan(a.nx);
  });

  it('clamps out-of-range and non-numeric values', async () => {
    const r = await outline({ ...NEEDLENOSE, clearance: 99, slotFrac: Number.NaN, u: 30, depth: 500 }, deps);
    const ref = await outline({ ...NEEDLENOSE, clearance: 5, u: 8, depth: 46.05 }, deps);
    expect(r.pocket).toEqual(ref.pocket);
    expect(r.effectiveDepth).toBeCloseTo(46.05, 10);
    expect(r.maxDepth).toBeCloseTo(46.05, 10);
  });

  it.each(TOOLS)('measures the %s pocket and tool along the upright axes', async (tool) => {
    const fx = presetFixture(tool);
    const params = { ...DEFAULTS, ...fx.params, tool, rot: 30 };
    const r = await outline(params, deps);
    const m = r.measure!;
    // the unrotated rings, in the upright frame
    const P0 = params.sym ? fx.symmetric_outline_mm : fx.outline_mm;
    const { tool: t, pocket: k } = makePocket(deps.manifold, P0, params);
    const tb = bounds(t), kb = bounds(k);
    expect(m.up2sheet).toEqual(fx.up2sheet);
    for (const key of ['xmin', 'xmax', 'ymin', 'ymax'] as const) {
      expect(m.pocket[key]).toBeCloseTo(kb[key], 6);
      expect(m.tool[key]).toBeCloseTo(tb[key], 6);
    }
    expect(m.pocketSize[0]).toBeCloseTo(kb.xmax - kb.xmin, 1);
    expect(m.pocketSize[1]).toBeCloseTo(kb.ymax - kb.ymin, 1);
    expect(m.toolSize[0]).toBeCloseTo(tb.xmax - tb.xmin, 1);
    expect(m.toolSize[1]).toBeCloseTo(tb.ymax - tb.ymin, 1);
    expect(m.gaps.xmin).toBeCloseTo(tb.xmin - kb.xmin, 1);
    expect(m.gaps.xmax).toBeCloseTo(kb.xmax - tb.xmax, 1);
    expect(m.gaps.ymin).toBeCloseTo(tb.ymin - kb.ymin, 1);
    expect(m.gaps.ymax).toBeCloseTo(kb.ymax - tb.ymax, 1);
    // the pocket box contains the tool box; the slot only widens it across the tool
    for (const g of Object.values(m.gaps)) expect(g).toBeGreaterThanOrEqual(params.clearance - 0.05);
    // the box mapped to the sheet holds the sheet pocket
    const [[a, b, c], [d, e, f]] = m.up2sheet;
    const back = (q: [number, number]) => {
      // invert the rigid map: A is a rotation (det 1), so A^-1 = A^T
      const x = q[0] - c, y = q[1] - f;
      return [a * x + d * y, b * x + e * y] as [number, number];
    };
    for (const q of r.sheetPocket) {
      const [x, y] = back(q);
      expect(x).toBeGreaterThanOrEqual(m.pocket.xmin - 0.02);
      expect(x).toBeLessThanOrEqual(m.pocket.xmax + 0.02);
      expect(y).toBeGreaterThanOrEqual(m.pocket.ymin - 0.02);
      expect(y).toBeLessThanOrEqual(m.pocket.ymax + 0.02);
    }
  });

  it('gives a half-grid footprint in half cells', async () => {
    const whole = await outline({ ...NEEDLENOSE }, deps);
    const half = await outline({ ...NEEDLENOSE, halfGrid: true }, deps);
    expect(Number.isInteger(half.nx * 2) && Number.isInteger(half.ny * 2)).toBe(true);
    expect(half.nx).toBeLessThanOrEqual(whole.nx);
    expect(half.pocket).toEqual(whole.pocket);
    expect(half.maxDepth).toBeCloseTo(whole.maxDepth, 9);
    const screws = await outline({ ...NEEDLENOSE, holes: 'screw', halfGrid: true }, deps);
    expect(screws.maxDepth).toBeCloseTo(whole.maxDepth, 9);
  });

  it('rejects unknown tools with a typed error', async () => {
    await expect(outline({ ...DEFAULTS, tool: 'nope' }, deps)).rejects.toMatchObject({ code: 'unknown-tool' });
  });

  it('serves registered uploads until they are removed', async () => {
    const p = await diskPresets.get('stripper');
    const tools = withUploads(diskPresets);
    tools.add({
      id: 'up-test', label: 'Mine', sym: false, outline: p.outline_mm, crop: p.crop_mm, up2sheet: p.up2sheet,
      symmetry: { outline: p.symmetric_outline_mm, score: p.symmetry_score, axisDeg: 0, offset: 0 },
      sheetBox: p.sheet_box_mm, sheetImage: 'blob:http://localhost/abc',
    });
    const up = { ...DEFAULTS, tool: 'up-test' };
    const r = await outline(up, { ...deps, presets: tools });
    const ref = await outline({ ...up, tool: 'stripper' }, deps);
    expect(r.pocket).toEqual(ref.pocket);
    expect(r.sheetImage).toBe('blob:http://localhost/abc');
    expect(r.symmetryScore).toBe(p.symmetry_score);
    expect((await tools.list()).map((t) => t.id)).not.toContain('up-test');
    tools.remove('up-test');
    await expect(outline(up, { ...deps, presets: tools })).rejects.toMatchObject({ code: 'unknown-tool' });
  });
});
