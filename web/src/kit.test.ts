import { describe, expect, it } from 'vitest';
import { rotate, type Ring } from './geometry/pocket';
import {
  affineAngle, axisAngle, clampPlacement, initialLayout, normalizeDeg, placeRing, resolveLayout, type Part,
} from './kit';
import { DEFAULTS } from './params';
import type { Affine } from './vision/outline';

const square = (s: number): Ring => [[-s, -s], [s, -s], [s, s], [-s, s]];

/** A part whose outline lies on the sheet turned by `deg` with its centre at (cx, cy). */
function part(id: string, deg: number, cx: number, cy: number, score = 1, axisDeg = 0): Part {
  const t = (deg * Math.PI) / 180;
  const up2sheet: Affine = [[Math.cos(t), -Math.sin(t), cx], [Math.sin(t), Math.cos(t), cy]];
  return {
    id, outline: square(10), crop: [44, 44], up2sheet,
    symmetry: { outline: square(10), score, axisDeg, offset: 0, centre: [0, 0] },
  };
}

describe('initialLayout', () => {
  it('puts a single part at the origin, turned by the rotation setting', () => {
    const l = initialLayout([part('p1', 30, 100, 50)], { ...DEFAULTS, rot: 20 });
    expect(l.placements).toEqual([{
      part: 'p1', x: 0, y: 0, rot: 20, sym: DEFAULTS.sym, clearance: DEFAULTS.clearance, slotOn: DEFAULTS.slotOn,
      slotR: DEFAULTS.slotR, slotOver: DEFAULTS.slotOver, slotFrac: DEFAULTS.slotFrac, depth: DEFAULTS.depth,
    }]);
  });

  it('keeps several parts where they were photographed, around their mean centre', () => {
    const parts = [part('p1', 0, 40, 100), part('p2', 90, 100, 100)];
    const [a, b] = initialLayout(parts, { ...DEFAULTS, rot: 45 }).placements;
    expect(a!.x).toBeCloseTo(-30, 9);
    expect(b!.x).toBeCloseTo(30, 9);
    expect(a!.y).toBeCloseTo(0, 9);
    expect(Math.hypot(b!.x - a!.x, b!.y - a!.y)).toBeCloseTo(60, 6);
    expect(a!.rot).toBeCloseTo(0, 6);
    expect(b!.rot).toBeCloseTo(90, 6);
    // the placed outline is the sheet outline moved by the group centre
    const q = parts[1]!;
    const onSheet = q.outline.map(([x, y]) => [
      q.up2sheet[0][0] * x + q.up2sheet[0][1] * y + q.up2sheet[0][2] - 70,
      q.up2sheet[1][0] * x + q.up2sheet[1][1] * y + q.up2sheet[1][2] - 100,
    ]);
    placeRing(q.outline, b!).forEach((pt, i) => {
      expect(pt[0]).toBeCloseTo(onSheet[i]![0]!, 6);
      expect(pt[1]).toBeCloseTo(onSheet[i]![1]!, 6);
    });
  });
});

describe('placement helpers', () => {
  it('placeRing turns, then moves', () => {
    const P: Ring = [[10, 0], [0, 5]];
    expect(placeRing(P, { x: 3, y: -2, rot: 0 })).toEqual([[13, -2], [3, 3]]);
    const r = placeRing(P, { x: 1, y: 1, rot: 90 });
    const want = rotate(P, 90).map(([x, y]) => [x + 1, y + 1]);
    r.forEach((pt, i) => {
      expect(pt[0]).toBeCloseTo(want[i]![0]!, 12);
      expect(pt[1]).toBeCloseTo(want[i]![1]!, 12);
    });
  });

  it('affineAngle reads the rotation of a rigid affine', () => {
    for (const deg of [-170, -90, 0, 33, 90, 180]) {
      expect(normalizeDeg(affineAngle(part('p', deg, 0, 0).up2sheet))).toBeCloseTo(normalizeDeg(deg), 9);
    }
  });

  it('normalizeDeg folds angles into (-180, 180]', () => {
    expect([0, 180, -180, 270, -270, 540, 359].map(normalizeDeg)).toEqual([0, 180, 180, -90, 90, 180, -1]);
  });

  it('axisAngle uses the mirror axis only for a symmetric enough part', () => {
    expect(axisAngle(part('p', 0, 0, 0, 0.95, 4.5))).toBe(4.5);
    expect(axisAngle(part('p', 0, 0, 0, 0.6, 4.5))).toBe(0);
  });

  it('clampPlacement clamps settings like the inspector and keeps the angle', () => {
    const c = clampPlacement({
      part: 'p1', x: Number.NaN, y: 5, rot: 450, sym: true, clearance: 99, slotOn: true, slotR: 1, slotOver: 6,
      slotFrac: 2, depth: -4, hidden: true,
    }, DEFAULTS);
    expect(c).toMatchObject({ part: 'p1', x: 0, y: 5, rot: 90, clearance: 5, slotR: 4, slotFrac: 1, depth: 0, hidden: true });
  });

  it('resolveLayout drops placements of unknown parts and keeps a locked size', () => {
    const parts = [part('p1', 0, 0, 0)];
    const l = resolveLayout(parts, DEFAULTS, {
      cells: [3, 2],
      placements: [
        { ...initialLayout(parts, DEFAULTS).placements[0]!, x: 12 },
        { ...initialLayout(parts, DEFAULTS).placements[0]!, part: 'gone' },
      ],
    });
    expect(l.placements.map((q) => [q.part, q.x])).toEqual([['p1', 12]]);
    expect(l.cells).toEqual([3, 2]);
    expect(resolveLayout(parts, DEFAULTS)).toEqual(initialLayout(parts, DEFAULTS));
  });
});
