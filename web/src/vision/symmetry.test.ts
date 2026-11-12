import { describe, expect, it } from 'vitest';
import { initManifold } from '../geometry/manifold';
import { signedArea, type Vec2 } from '../geometry/pocket';
import { hausdorff, presetFixture, TOOLS } from '../test/fixtures';
import { mirrorScore, symmetrize } from './symmetry';

interface SymmetryFixture {
  symmetry_axis: { deg: number; offset_mm: number; centre_mm: Vec2 };
}

describe.each(TOOLS)('symmetrize %s', (tool) => {
  const fx = presetFixture(tool) as ReturnType<typeof presetFixture> & SymmetryFixture;

  it('finds the Python mirror axis and score, and contains the original outline', async () => {
    const m = await initManifold();
    const sym = symmetrize(m, fx.outline_mm);
    expect(Math.abs(sym.score - fx.symmetry_score)).toBeLessThan(0.02);
    expect(sym.score > 0.92).toBe(tool !== 'stripper');
    expect(sym.centre[0]).toBeCloseTo(fx.symmetry_axis.centre_mm[0], 2);
    expect(sym.centre[1]).toBeCloseTo(fx.symmetry_axis.centre_mm[1], 2);
    expect(Math.abs(sym.axisDeg - fx.symmetry_axis.deg)).toBeLessThan(0.3);
    expect(Math.abs(sym.offset - fx.symmetry_axis.offset_mm)).toBeLessThan(0.3);

    expect(sym.outline).toHaveLength(720);
    expect(signedArea(sym.outline)).toBeGreaterThan(0);
    expect(hausdorff(sym.outline, fx.symmetric_outline_mm)).toBeLessThan(0.5);
    const orig = new m.CrossSection([fx.outline_mm], 'NonZero');
    const S = new m.CrossSection([sym.outline], 'NonZero');
    const outside = orig.subtract(S);
    try {
      expect(outside.area()).toBeLessThan(1.0);
    } finally {
      for (const x of [orig, S, outside]) x.delete();
    }
    // the result is mirror-symmetric about its own axis
    expect(mirrorScore(m, sym.outline, sym.centre, sym.axisDeg, sym.offset)).toBeGreaterThan(0.995);
  });
});
