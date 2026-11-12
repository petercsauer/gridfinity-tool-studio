import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initManifold } from './manifold';
import { binSize, effectiveDepth, footprint, makePocket, maxDepth, rotate, signedArea, type Ring } from './pocket';
import { hausdorff, presetFixture, TOOLS } from '../test/fixtures';

let m: ManifoldToplevel;
beforeAll(async () => {
  m = await initManifold();
});

describe.each(TOOLS)('pocket parity: %s', (tool) => {
  const fx = presetFixture(tool);
  const p = fx.params;
  const outline = p.sym ? fx.symmetric_outline_mm : fx.outline_mm;

  it('matches the Python pocket (area within 1%, Hausdorff <= 0.5 mm)', () => {
    const { pocket } = makePocket(m, rotate(outline, p.rot), p);
    const a = Math.abs(signedArea(pocket));
    const ref = Math.abs(signedArea(fx.pocket_mm));
    expect(Math.abs(a - ref) / ref).toBeLessThan(0.01);
    expect(hausdorff(pocket, fx.pocket_mm)).toBeLessThanOrEqual(0.5);
  });

  it('gives the same footprint', () => {
    const { pocket } = makePocket(m, rotate(outline, p.rot), p);
    expect(footprint(pocket, p.fillet)).toEqual(fx.footprint);
  });

  it('keeps the tool polygon equal to the outline', () => {
    const { tool: ring } = makePocket(m, outline, p);
    expect(hausdorff(ring, outline)).toBeLessThan(0.05);
  });
});

describe('pocket edge cases', () => {
  const fx = presetFixture('needlenose');
  it.each([0, 1, 0.5, -3, 7])('slotFrac %s does not throw', (slotFrac) => {
    const { pocket } = makePocket(m, fx.outline_mm, { ...fx.params, slotFrac });
    expect(pocket.length).toBeGreaterThan(10);
  });

  it('works without a slot and with zero clearance', () => {
    const { tool, pocket } = makePocket(m, fx.outline_mm, { ...fx.params, slotOn: false, clearance: 0 });
    expect(Math.abs(signedArea(pocket))).toBeCloseTo(Math.abs(signedArea(tool)), 0);
  });

  it('accepts a clockwise outline', () => {
    const a = makePocket(m, fx.outline_mm, fx.params).pocket;
    const b = makePocket(m, [...fx.outline_mm].reverse(), fx.params).pocket;
    expect(hausdorff(a, b)).toBeLessThan(1e-6);
  });

  it('grows the footprint for a rotated tool (needlenose, 20 deg, clearance 2)', () => {
    const { pocket } = makePocket(m, rotate(fx.outline_mm, 20), { ...fx.params, clearance: 2 });
    const [nx] = footprint(pocket, fx.params.fillet);
    const w = Math.max(...pocket.map((q) => q[0])) - Math.min(...pocket.map((q) => q[0]));
    expect(42 * nx - 0.5).toBeGreaterThanOrEqual(w + 2 * fx.params.fillet + 2 * (3.2 + 1.2));
  });
});

describe('depth limits', () => {
  it('matches max_depth(u) = u*7 - 4.4 - 5.55, clamped at 0', () => {
    expect(maxDepth(1)).toBe(0);
    expect(maxDepth(3)).toBeCloseTo(11.05, 10);
    expect(maxDepth(8)).toBeCloseTo(46.05, 10);
  });
  it('caps the requested depth', () => {
    expect(effectiveDepth(3, 10)).toBe(10);
    expect(effectiveDepth(3, 40)).toBeCloseTo(11.05, 10);
    expect(effectiveDepth(1, 10)).toBe(0);
  });
  it('agrees with the fixture effective depth', () => {
    for (const tool of TOOLS) {
      const fx = presetFixture(tool);
      expect(effectiveDepth(fx.params.u, fx.params.depth)).toBeCloseTo(fx.bin.effective_depth, 4);
    }
  });
});

describe('half-grid footprint', () => {
  /** A rectangular pocket `w` x `h` mm. */
  const rect = (w: number, h: number): Ring => [[0, 0], [w, 0], [w, h], [0, h]];
  // with no fillet the margin is 2 * (3.2 + 1.2) + 0.5 = 9.3 mm, so a 50.7 mm pocket needs 60 mm
  it('grows in 21 mm steps: a pocket that needs 60 mm is 1.5 units instead of 2', () => {
    expect(footprint(rect(50.7, 50.7), 0)).toEqual([2, 2]);
    const [nx, ny] = footprint(rect(50.7, 50.7), 0, true);
    expect([nx, ny]).toEqual([1.5, 1.5]);
    expect(42 * nx).toBeCloseTo(63, 9); // pitch box
    expect(binSize(nx)).toBeCloseTo(62.5, 9); // outer size
    expect(binSize(2)).toBeCloseTo(83.5, 9);
  });

  it('keeps whole units when they fit, and can be half a unit', () => {
    expect(footprint(rect(74.6, 11.6), 0, true)).toEqual([2, 0.5]); // needs 83.9 and 20.9 mm
    expect(footprint(rect(74.8, 11.8), 0, true)).toEqual([2.5, 1]);
    expect(footprint(rect(74.8, 11.8), 0)).toEqual([3, 1]);
  });

  it('counts the top fillet like the full grid does', () => {
    expect(footprint(rect(40, 40), 3, true)).toEqual([1.5, 1.5]); // 40 + 6 + 9.3 = 55.3 mm
    expect(footprint(rect(40, 40), 3)).toEqual([2, 2]);
  });

  it('caps the depth as if there were no holes', () => {
    expect(maxDepth(4, { holes: 'screw', halfGrid: true })).toBeCloseTo(maxDepth(4), 9);
    expect(maxDepth(4, { holes: 'screw' })).toBeLessThan(maxDepth(4));
    expect(effectiveDepth(4, 30, { holes: 'both', halfGrid: true })).toBeCloseTo(maxDepth(4), 9);
  });
});
