import { describe, expect, it } from 'vitest';
import type { Ring, Vec2 } from './geometry/pocket';
import { placeRing, type Placement } from './kit';
import { binToScreen, hitTest, inRing, screenToBin, snapRot, turnAbout, type ViewXf } from './layout-view';
import { DEFAULTS } from './params';

const square = (cx: number, cy: number, s: number): Ring => [[cx - s, cy - s], [cx + s, cy - s], [cx + s, cy + s], [cx - s, cy + s]];

describe('snapRot', () => {
  it('snaps the axis to 90 within 5 degrees', () => {
    expect(snapRot(87, 0, null, false)).toEqual({ rot: 90, snapped: 90 });
    expect(snapRot(84, 0, null, false)).toEqual({ rot: 84, snapped: null });
    expect(snapRot(-2, 0, null, false)).toEqual({ rot: 0, snapped: 0 });
    expect(snapRot(183, 0, null, false)).toEqual({ rot: 180, snapped: 180 });
  });

  it('snaps on the symmetry axis, not the part frame', () => {
    expect(snapRot(95, -4, null, false)).toEqual({ rot: 94, snapped: 90 });
    expect(snapRot(25, -25, null, false)).toEqual({ rot: 25, snapped: 0 });
  });

  it('holds a snap until 8 degrees away (hysteresis)', () => {
    expect(snapRot(97, 0, null, false).snapped).toBeNull();
    expect(snapRot(97, 0, 90, false)).toEqual({ rot: 90, snapped: 90 });
    expect(snapRot(99, 0, 90, false)).toEqual({ rot: 99, snapped: null });
    // the hysteresis only holds the multiple it is snapped to
    expect(snapRot(7, 0, 90, false).snapped).toBeNull();
  });

  it('never snaps when free', () => {
    for (const r of [0, 1, 87, 90, 95]) expect(snapRot(r, 0, 90, true)).toEqual({ rot: r, snapped: null });
  });
});

describe('hitTest', () => {
  const a = square(0, 0, 10);
  const b = square(8, 0, 10);

  it('returns the topmost of overlapping pockets and null outside', () => {
    expect(hitTest([5, 0], [a, b])).toBe(1);
    expect(hitTest([5, 0], [b, a])).toBe(1);
    expect(hitTest([-5, 0], [a, b])).toBe(0);
    expect(hitTest([16, 0], [a, b])).toBe(1);
    expect(hitTest([30, 0], [a, b])).toBeNull();
    expect(hitTest([0, 11], [a, b])).toBeNull();
  });

  it('uses even-odd on concave rings', () => {
    const U: Ring = [[0, 0], [30, 0], [30, 30], [20, 30], [20, 10], [10, 10], [10, 30], [0, 30]];
    expect(inRing([5, 20], U)).toBe(true);
    expect(inRing([15, 20], U)).toBe(false); // in the notch
    expect(inRing([15, 5], U)).toBe(true);
  });
});

describe('screen mapping', () => {
  for (const dpr of [1, 2]) {
    it(`round-trips at dpr ${dpr}`, () => {
      const v: ViewXf = { s: 3.2, ox: 410, oy: 250, dpr };
      for (const p of [[0, 0], [12.5, -30], [-80, 41]] as Vec2[]) {
        const q = screenToBin(binToScreen(p, v), v);
        expect(q[0]).toBeCloseTo(p[0], 9);
        expect(q[1]).toBeCloseTo(p[1], 9);
      }
      // a css pixel 32 px right of and 16 px above the origin is 10 mm right and 5 mm up, at any dpr
      const [x, y] = screenToBin([(410 + 32) * dpr, (250 - 16) * dpr], v);
      expect(x).toBeCloseTo(10, 9);
      expect(y).toBeCloseTo(5, 9);
    });
  }
});

describe('turnAbout', () => {
  it('turns a placement about a part-frame point that stays put', () => {
    const pl: Placement = { ...DEFAULTS, part: 'p1', x: 5, y: -3, rot: 30 } as Placement;
    const c: Vec2 = [4, 7];
    const before = placeRing([c], pl)[0]!;
    const t = turnAbout(pl, c, 120);
    expect(t.rot).toBe(120);
    const after = placeRing([c], t)[0]!;
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
  });
});
