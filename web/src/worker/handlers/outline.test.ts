import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { liveObjects } from '../../geometry/bin';
import { initManifold } from '../../geometry/manifold';
import { bounds, footprint, makePocket, type Ring } from '../../geometry/pocket';
import { placeRing, settingsFromParams, type Layout } from '../../kit';
import { hausdorff, presetFixture, TOOLS } from '../../test/fixtures';
import { DEFAULTS } from '../../params';
import type { Deps } from '../deps';
import { partFromPreset, withUploads, type PresetData, type PresetSource } from '../presets';
import { PipelineError, type OutlineResult } from '../protocol';
import { refit } from '../../path/edit';
import { toRing } from '../../path/ring';
import { build } from './build';
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
    expect(hausdorff(r.parts[0]!.pocket, fx.pocket_mm)).toBeLessThanOrEqual(0.5);
    const [[a, b, c], [d, e, f]] = fx.up2sheet;
    const mapped = fx.pocket_mm.map(([x, y]) => [a * x + b * y + c, d * x + e * y + f] as [number, number]);
    expect(hausdorff(r.parts[0]!.sheetPocket, mapped)).toBeLessThanOrEqual(0.5);
    expect(r.sheetImage).toBe(`presets/${tool}-sheet.jpg`);
    expect(r.effectiveDepth).toBe(fx.bin.effective_depth);
  });
});

describe('outline handler parameters', () => {
  it('keeps the sheet trace unrotated when the pocket is rotated', async () => {
    const a = await outline({ ...NEEDLENOSE, rot: 0 }, deps);
    const b = await outline({ ...NEEDLENOSE, rot: 45 }, deps);
    expect(b.parts[0]!.sheetPocket).toEqual(a.parts[0]!.sheetPocket);
    expect(b.nx).toBeGreaterThan(a.nx);
  });

  it('clamps out-of-range and non-numeric values', async () => {
    const r = await outline({ ...NEEDLENOSE, clearance: 99, slotFrac: Number.NaN, u: 30, depth: 500 }, deps);
    const ref = await outline({ ...NEEDLENOSE, clearance: 5, u: 8, depth: 46.05 }, deps);
    expect(r.parts[0]!.pocket).toEqual(ref.parts[0]!.pocket);
    expect(r.effectiveDepth).toBeCloseTo(46.05, 10);
    expect(r.maxDepth).toBeCloseTo(46.05, 10);
  });

  it.each(TOOLS)('measures the %s pocket and tool along the upright axes', async (tool) => {
    const fx = presetFixture(tool);
    const params = { ...DEFAULTS, ...fx.params, tool, rot: 30 };
    const r = await outline(params, deps);
    const m = r.parts[0]!.measure;
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
    for (const q of r.parts[0]!.sheetPocket) {
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
    expect(half.parts[0]!.pocket).toEqual(whole.parts[0]!.pocket);
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
      id: 'up-test', label: 'Mine', sym: false, parts: [partFromPreset(p)],
      sheetBox: p.sheet_box_mm, sheetImage: 'blob:http://localhost/abc',
    });
    const up = { ...DEFAULTS, tool: 'up-test' };
    const r = await outline(up, { ...deps, presets: tools });
    const ref = await outline({ ...up, tool: 'stripper' }, deps);
    expect(r.parts[0]!.pocket).toEqual(ref.parts[0]!.pocket);
    expect(r.sheetImage).toBe('blob:http://localhost/abc');
    expect(r.parts[0]!.symmetryScore).toBe(p.symmetry_score);
    expect((await tools.list()).map((t) => t.id)).not.toContain('up-test');
    tools.remove('up-test');
    await expect(outline(up, { ...deps, presets: tools })).rejects.toMatchObject({ code: 'unknown-tool' });
  });
});

describe('kits with several parts', () => {
  /** A kit of the needle-nose and the stripper (the stripper's sheet placement), as one preset. */
  const kitPresets: PresetSource = {
    ...diskPresets,
    get: async (id) => {
      if (id !== 'kit') return diskPresets.get(id);
      const nn = await diskPresets.get('needlenose');
      const st = await diskPresets.get('stripper');
      return { ...nn, id: 'kit', parts: [partFromPreset(nn, 'p1'), partFromPreset(st, 'p2')] };
    },
  };
  const params = { ...DEFAULTS, tool: 'kit', sym: false };
  const layout = (dx: number): Layout => ({
    placements: [
      { part: 'p1', x: -dx, y: 0, rot: 0, ...settingsFromParams(params) },
      { part: 'p2', x: dx, y: 0, rot: 90, ...settingsFromParams(params) },
    ],
  });
  let kd: Deps;
  beforeAll(() => {
    kd = { ...deps, presets: kitPresets };
  });

  it('traces every part in its own frame and on the sheet where it lay', async () => {
    const r = await outline(params, kd, layout(60));
    expect(r.parts.map((q) => q.id)).toEqual(['p1', 'p2']);
    const alone = await outline({ ...params, tool: 'stripper' }, deps);
    expect(r.parts[1]!.sheetPocket).toEqual(alone.parts[0]!.sheetPocket);
    expect(r.parts[1]!.pocket).toEqual(alone.parts[0]!.pocket);
    expect(r.layout.placements.map((q) => q.x)).toEqual([-60, 60]);
  });

  it('sizes the bin for all placed pockets, and grows as they move apart', async () => {
    const near = await outline(params, kd, layout(40));
    const far = await outline(params, kd, layout(90));
    const placed = near.parts.map((q, i) => placeRing(q.pocket, near.layout.placements[i]!));
    expect([near.nx, near.ny]).toEqual(footprint(placed, params.fillet));
    expect(far.nx).toBeGreaterThan(near.nx);
    expect(far.w).toBeCloseTo(near.w + 100, 0);
  });

  it('builds the bin it sized, with both pockets cut', async () => {
    // without round-overs, to keep this quick
    const flat = { ...params, fillet: 0 };
    const o = await outline(flat, kd, layout(60));
    const b = await build(flat, kd, layout(60));
    expect([b.nx, b.ny]).toEqual([o.nx, o.ny]);
    expect(b.indices.length).toBeGreaterThan(1000);
    const one = await outline(flat, kd, { placements: [layout(60).placements[0]!, { ...layout(60).placements[1]!, hidden: true }] });
    expect(one.nx).toBeLessThan(o.nx);
  });

  it('starts several parts as photographed and refuses a layout with every part hidden', async () => {
    const r = await outline(params, kd);
    expect(r.layout.placements).toHaveLength(2);
    const [a, c] = r.layout.placements;
    expect(Math.hypot(c!.x - a!.x, c!.y - a!.y)).toBeGreaterThan(0);
    const hidden = layout(60).placements.map((q) => ({ ...q, hidden: true }));
    await expect(outline(params, kd, { placements: hidden })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('cuts the finger slot across a turned part', async () => {
    const turned = await outline(params, kd, {
      placements: [{ part: 'p1', x: 0, y: 0, rot: 90, ...settingsFromParams(params) }],
    });
    const straight = await outline(params, kd, {
      placements: [{ part: 'p1', x: 0, y: 0, rot: 0, ...settingsFromParams(params) }],
    });
    // the same pocket, turned: width and length swap
    expect(turned.w).toBeCloseTo(straight.h, 1);
    expect(turned.h).toBeCloseTo(straight.w, 1);
  });

  it('gives each placement its own finger slot, across the part at any angle', async () => {
    const own = settingsFromParams(params);
    const r = await outline(params, kd, {
      placements: [
        { part: 'p1', x: -40, y: 0, rot: 90, ...own, slotOn: true, slotOver: 20 },
        { part: 'p1', x: 40, y: 0, rot: 90, ...own, slotOn: false },
      ],
    });
    const box = (i: number) => {
      const b = bounds(placeRing(r.parts[i]!.pocket, r.layout.placements[i]!));
      return { w: b.xmax - b.xmin, h: b.ymax - b.ymin };
    };
    const slotted = box(0), plain = box(1);
    // the slot runs along the bin's y (across the turned part): it adds the pill's length past the pocket there,
    // the crossing width plus 2 * (slotOver + slotR), and nothing along the part
    const tb = bounds(r.parts[0]!.tool);
    const pill = tb.xmax - tb.xmin + 2 * (own.clearance + 20 + own.slotR);
    expect(slotted.h).toBeGreaterThan(plain.h + 1);
    expect(slotted.h).toBeLessThanOrEqual(pill + 0.5);
    expect(slotted.w).toBeCloseTo(plain.w, 1);
  });

  it('uses a locked bin size as given, with the placements as bin coordinates', async () => {
    const flat = { ...params, fillet: 0 };
    const outside = (r: OutlineResult) => r.warnings?.filter((w) => w.kind === 'outside');
    const auto = await outline(flat, kd, layout(60));
    const cells: [number, number] = [auto.nx, auto.ny];
    // the auto bin is centred on the pockets; the same placements moved there fit it once locked
    const b = bounds(auto.parts.flatMap((q, i) => placeRing(q.pocket, auto.layout.placements[i]!)));
    const at = (dx: number) => auto.layout.placements.map((q) => ({ ...q, x: q.x - (b.xmin + b.xmax) / 2 + dx, y: q.y - (b.ymin + b.ymax) / 2 }));
    const fits = await outline(flat, kd, { placements: at(0), cells });
    expect([fits.nx, fits.ny]).toEqual(cells);
    expect(outside(fits)).toEqual([]);
    // moved 40 mm right, the stripper leaves the locked bin rather than the bin following the parts
    expect(outside(await outline(flat, kd, { placements: at(40) }))).toEqual([]);
    expect(outside(await outline(flat, kd, { placements: at(40), cells }))).toEqual([{ kind: 'outside', parts: ['p2'] }]);
    const bigger = await outline(flat, kd, { ...layout(60), cells: [8, 8] });
    expect([bigger.nx, bigger.ny]).toEqual([8, 8]);
  });

  it('warns of overlapping parts in the outline and builds them merged, each at its own depth', async () => {
    const flat = { ...params, fillet: 0, u: 6 };
    const own = settingsFromParams(flat);
    const kit: Layout = {
      placements: [
        { part: 'p1', x: 0, y: 0, rot: 0, ...own, depth: 8 },
        { part: 'p2', x: 10, y: 0, rot: 0, ...own, depth: 20 },
        { part: 'p1', x: 0, y: 0, rot: 0, ...own, hidden: true },
      ],
    };
    const o = await outline(flat, kd, kit);
    expect(o.warnings).toEqual([{ kind: 'overlap', parts: ['p1', 'p2'] }]);
    const b = await build(flat, kd, kit);
    expect(b.effectiveDepths).toEqual([8, 20, 0]);
    expect(b.effectiveDepth).toBe(20);
  });
});

describe('kit build performance', () => {
  /** Twelve fixture parts (each tool three times, at 40%, so they fit an 8x8 bin) as one preset. */
  const SCALE = 0.4;
  const ids = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);
  const twelve: PresetSource = {
    ...diskPresets,
    get: async (id) => {
      if (id !== 'twelve') return diskPresets.get(id);
      const tools = await Promise.all(TOOLS.map((t) => diskPresets.get(t)));
      const parts = ids.map((pid, i) => {
        const part = partFromPreset(tools[i % TOOLS.length]!, pid);
        const s = (P: Ring): Ring => P.map(([x, y]) => [x * SCALE, y * SCALE]);
        return { ...part, outline: s(part.outline), symmetry: { ...part.symmetry, outline: s(part.symmetry.outline) } };
      });
      return { ...tools[0]!, id: 'twelve', parts };
    },
  };

  // under 5 s here, under 20 s on CI's runners (about 2.5x slower; this build took 26 s here before the
  // round-over layers were simplified, so either bound still catches that coming back)
  const LIMIT = process.env.CI ? 20_000 : 5_000;

  it('builds 12 placed parts, each with its own depth, in a few seconds and frees everything', async () => {
    // with the default top round-over, the costliest part of each pocket
    const params = { ...DEFAULTS, tool: 'twelve', sym: false, u: 5, slotR: 5, slotOver: 2 };
    const own = settingsFromParams(params);
    // six columns of two rows
    const layout: Layout = {
      placements: ids.map((part, i) => ({
        part, x: -112.5 + 45 * (i % 6), y: i < 6 ? -50 : 50, rot: 0, ...own, depth: 6 + (i % 4) * 4,
      })),
    };
    const kd: Deps = { ...deps, presets: twelve };
    const t0 = performance.now();
    const r = await build(params, kd, layout);
    const ms = performance.now() - t0;
    expect(r.effectiveDepths).toEqual(layout.placements.map((q) => q.depth));
    expect(ms).toBeLessThan(LIMIT);
    expect(liveObjects()).toBe(0);
  }, 120_000);
});

describe('edited outlines', () => {
  const params = { ...DEFAULTS, tool: 'stripper', sym: false };
  it('cuts the pocket from a part\'s edited path, and ignores one that crosses itself', async () => {
    const r0 = await outline(params, deps);
    const pl = r0.layout.placements[0]!;
    // the fitted outline with one point pulled 1 mm out, away from the middle
    const path = refit(r0.parts[0]!.traced, 0.3);
    const a = path.anchors[3]!;
    const cx = path.anchors.reduce((t, x) => t + x.p[0], 0) / path.anchors.length;
    const cy = path.anchors.reduce((t, x) => t + x.p[1], 0) / path.anchors.length;
    const l = Math.hypot(a.p[0] - cx, a.p[1] - cy);
    const out: [number, number] = [a.p[0] + (a.p[0] - cx) / l, a.p[1] + (a.p[1] - cy) / l];
    const pulled = { anchors: path.anchors.map((x, k) => (k === 3 ? { ...a, p: out } : x)) };
    const r = await outline(params, deps, { placements: [{ ...pl, path: pulled }] });
    expect(r.parts[0]!.edited).toBe(true);
    expect(r.parts[0]!.traced).toEqual(r0.parts[0]!.traced);
    expect(hausdorff(r.parts[0]!.tool, toRing(pulled))).toBeLessThan(0.05);
    expect(r.parts[0]!.sheetAxis).toBeUndefined();
    // a figure-eight: the traced outline is used instead
    const crossed = { anchors: [[0, 0], [20, 20], [20, 0], [0, 20]].map((p) => ({ p: p as [number, number], hin: [0, 0] as [number, number], hout: [0, 0] as [number, number], kind: 'corner' as const })) };
    const bad = await outline(params, deps, { placements: [{ ...pl, path: crossed }] });
    expect(bad.parts[0]!.edited).toBe(false);
    expect(bad.parts[0]!.pocket).toEqual(r0.parts[0]!.pocket);
    // junk is dropped by the clamp
    const junk = await outline(params, deps, { placements: [{ ...pl, path: { anchors: [{ p: [Number.NaN, 0] }] } as never }] });
    expect(junk.layout.placements[0]!.path).toBeUndefined();
  });
});
