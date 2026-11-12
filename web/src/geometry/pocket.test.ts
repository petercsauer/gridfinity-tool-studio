import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initManifold } from './manifold';
import { effectiveDepth, footprint, makePocket, maxDepth, rotate, signedArea } from './pocket';
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
