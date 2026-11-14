import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initManifold } from './geometry/manifold';
import { bounds, footprint, makePocket, tipPoint, type Ring } from './geometry/pocket';
import { arrange, packGap } from './kit-pack';
import { placeRing } from './kit';
import { DEFAULTS } from './params';
import { presetFixture, TOOLS } from './test/fixtures';

let m: ManifoldToplevel;
beforeAll(async () => {
  m = await initManifold();
});

const rect = (w: number, h: number): Ring => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
/** Gap between two boxes (negative when they overlap). */
function gapBetween(a: Ring, b: Ring): number {
  const A = bounds(a), B = bounds(b);
  const dx = Math.max(B.xmin - A.xmax, A.xmin - B.xmax), dy = Math.max(B.ymin - A.ymax, A.ymin - B.ymax);
  return Math.max(dx, dy);
}

describe('arrange', () => {
  const fillet = 3.175, gap = packGap(fillet);

  it('packs an analyser and its antennas into fewer cells than a row, apart by the gap', () => {
    // pockets of a 75 x 132 box and three antennas, as traced (axis along y)
    const parts = [
      { id: 'p1', pocket: rect(12, 50), axisDeg: 0 },
      { id: 'p2', pocket: rect(80, 137), axisDeg: 0 },
      { id: 'p3', pocket: rect(15, 115), axisDeg: 0 },
      { id: 'p4', pocket: rect(21, 125), axisDeg: 0 },
    ];
    const r = arrange(parts, { gap, fillet, halfGrid: false });
    const placed = r.placements.map((q) => placeRing(parts.find((p) => p.id === q.part)!.pocket, q));
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) expect(gapBetween(placed[i]!, placed[j]!)).toBeGreaterThanOrEqual(gap - 1e-6);
    }
    // the footprint it reports is the real one: 4 x 4 (a 3-cell side holds 110 mm, but the box and two antennas
    // side by side with the gaps need 131 mm)
    expect(footprint(placed, fillet)).toEqual([r.nx, r.ny]);
    expect(r.nx * r.ny).toBe(16);
    // with thin round-overs, the gaps shrink and it fits in fewer
    const tight = arrange(parts, { gap: packGap(0.5), fillet: 0.5, halfGrid: true });
    expect(tight.nx * tight.ny).toBeLessThan(16);
    // every rotation keeps the snap axis along x or y
    for (const q of r.placements) expect(((q.rot % 90) + 90) % 90).toBeCloseTo(0, 9);
  });

  it('turns a part by its snap axis', () => {
    const r = arrange([{ id: 'a', pocket: rect(10, 100), axisDeg: 7 }, { id: 'b', pocket: rect(10, 100), axisDeg: -3 }], { gap, fillet, halfGrid: false });
    const rots = r.placements.map((q) => q.rot);
    expect([7 + rots[0]!, -3 + rots[1]!].every((v) => Math.abs(((v % 90) + 90) % 90) < 1e-9 || Math.abs((((v % 90) + 90) % 90) - 90) < 1e-9)).toBe(true);
  });

  it('packs the four fixture tools without overlaps', () => {
    const parts = TOOLS.map((t) => ({ id: t, pocket: presetFixture(t).pocket_mm, axisDeg: 0 }));
    const r = arrange(parts, { gap, fillet, halfGrid: true });
    const placed = r.placements.map((q) => placeRing(parts.find((p) => p.id === q.part)!.pocket, q));
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) expect(gapBetween(placed[i]!, placed[j]!)).toBeGreaterThanOrEqual(gap - 1e-6);
    }
    expect(footprint(placed, fillet, true)).toEqual([r.nx, r.ny]);
  });
});

describe('a finger hole at the tip', () => {
  it('is centred on the narrower end, in place of the slot across', () => {
    // a tapered bar: 20 mm wide at the bottom (y = 50), 6 mm at the top (y = -50)
    const bar: Ring = [[-3, -50], [3, -50], [10, 50], [-10, 50]];
    expect(tipPoint([bar])).toEqual([0, -50]);
    expect(tipPoint([bar], true)).toEqual([0, 50]);
    const p = { ...DEFAULTS, clearance: 1, slotR: 8, slotOn: true };
    const tip = makePocket(m, bar, { ...p, slotTip: true });
    const plain = makePocket(m, bar, { ...p, slotOn: false });
    const across = makePocket(m, bar, p);
    const bt = bounds(tip.pocket), bp = bounds(plain.pocket);
    // the hole: 8 mm round the tip, so 8 mm past it, and as wide as it, at the top only
    expect(bt.ymin).toBeCloseTo(-58, 1);
    expect(bt.ymax).toBeCloseTo(bp.ymax, 6);
    expect(bt.xmax).toBeCloseTo(Math.max(8, bp.xmax), 1);
    // and no slot across: narrower than the slotted pocket
    expect(bt.xmax - bt.xmin).toBeLessThan(bounds(across.pocket).xmax - bounds(across.pocket).xmin);
  });
});

describe('slot length', () => {
  it('shrinks the slot about the middle, down to a round hole', () => {
    const bar: Ring = [[-5, -60], [5, -60], [5, 60], [-5, 60]];
    const p = { ...DEFAULTS, clearance: 1, slotR: 10, slotOver: 6, slotFrac: 0.5, slotOn: true };
    const full = bounds(makePocket(m, bar, p).pocket);
    const same = bounds(makePocket(m, bar, { ...p, slotSpan: 1 }).pocket);
    const half = bounds(makePocket(m, bar, { ...p, slotSpan: 0.5 }).pocket);
    const round = bounds(makePocket(m, bar, { ...p, slotSpan: 0 }).pocket);
    expect(same).toEqual(full);
    // full: the pocket's 6 mm half-width plus 6 mm over plus the 10 mm radius each side
    expect(full.xmax).toBeCloseTo(6 + 6 + 10, 1);
    expect(half.xmax).toBeCloseTo((6 + 6) / 2 + 10, 1);
    // a circle of radius 10 in the middle
    expect(round.xmax).toBeCloseTo(10, 1);
    expect(round.xmin).toBeCloseTo(-10, 1);
    expect(round.ymax).toBeCloseTo(full.ymax, 6);
  });
});
