import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initManifold } from './manifold';
import { checkLayout } from './kit-checks';
import type { Ring } from './pocket';

let m: ManifoldToplevel;
beforeAll(async () => {
  m = await initManifold();
});

const rect = (x0: number, y0: number, w: number, h: number): Ring => [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];
const p = { fillet: 3.175 };

describe('checkLayout', () => {
  it('warns of a thin wall between pockets 0.5 mm apart', () => {
    const w = checkLayout(m, [{ id: 'a', ring: rect(-20, -10, 19.75, 20) }, { id: 'b', ring: rect(0.25, -10, 20, 20) }], p);
    expect(w).toEqual([{ kind: 'thin-wall', parts: ['a', 'b'] }]);
  });

  it('has nothing to say about pockets 15 mm apart', () => {
    const pockets = [{ id: 'a', ring: rect(-27.5, -10, 20, 20) }, { id: 'b', ring: rect(7.5, -10, 20, 20) }];
    expect(checkLayout(m, pockets, p)).toEqual([]);
    expect(checkLayout(m, pockets, p, [2, 1])).toEqual([]);
  });

  it('warns of overlapping pockets (only that, not a thin wall too)', () => {
    const w = checkLayout(m, [{ id: 'a', ring: rect(-20, -10, 25, 20) }, { id: 'b', ring: rect(0, -10, 20, 20) }], p);
    expect(w).toEqual([{ kind: 'overlap', parts: ['a', 'b'] }]);
  });

  it('warns of a pocket past the usable area of a locked 2x2 bin', () => {
    // usable: 83.5 - 2 * (3.2 + 1.2 + 3.175) = 68.35 mm square, centred
    const inside = { id: 'a', ring: rect(-30, -30, 20, 20) };
    const past = { id: 'b', ring: rect(20, -10, 20, 20) };
    expect(checkLayout(m, [inside, past], p, [2, 2])).toEqual([{ kind: 'outside', parts: ['b'] }]);
    // without a locked size the bin grows to fit
    expect(checkLayout(m, [inside, past], p)).toEqual([]);
  });
});
