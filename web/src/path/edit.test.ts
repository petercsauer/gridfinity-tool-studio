import { describe, expect, it } from 'vitest';
import type { Ring, Vec2 } from '../geometry/pocket';
import { presetFixture } from '../test/fixtures';
import { dist, evaluate, isStraight, len, segment, type BezierPath } from './bezier';
import { bendSegment, deleteAnchor, isValid, moveAnchor, moveHandle, refit, roundCorner, toggleKind } from './edit';
import { toRing } from './ring';

const collinear = (a: Vec2, b: Vec2) => Math.abs(a[0] * b[1] - a[1] * b[0]) < 1e-9 && a[0] * b[0] + a[1] * b[1] < 0;

/** A square with straight sides and one smooth bulge on its top side. */
const square: BezierPath = { anchors: [
  { p: [0, 0], hin: [0, 0], hout: [0, 0], kind: 'corner' },
  { p: [40, 0], hin: [0, 0], hout: [0, 0], kind: 'corner' },
  { p: [40, 40], hin: [0, 0], hout: [-6, 0], kind: 'corner' },
  { p: [20, 45], hin: [8, 0], hout: [-8, 0], kind: 'smooth' },
  { p: [0, 40], hin: [6, 0], hout: [0, 0], kind: 'corner' },
] };

describe('outline edits', () => {
  it('moves a point with its handles, snapping a nearly level straight side level', () => {
    // the bottom side ends up 1.1 degrees off level and snaps; the right side, 7 degrees off, doesn't
    const m = moveAnchor(square, 1, [45, 0.9]);
    expect(m.anchors[1]!.p).toEqual([45, 0]);
    expect(moveAnchor(square, 1, [45, 0.9], false).anchors[1]!.p).toEqual([45, 0.9]);
    // a corner moved a little keeps both its straight sides square
    expect(moveAnchor(square, 1, [41, 0.9]).anchors[1]!.p).toEqual([40, 0]);
    const s = moveAnchor(square, 3, [22, 50]);
    expect(s.anchors[3]).toMatchObject({ p: [22, 50], hin: [8, 0], hout: [-8, 0] });
  });

  it('keeps a smooth point smooth when a handle is dragged, and Alt breaks it into a corner', () => {
    const m = moveHandle(square, 3, 'out', [10, 50]);
    const a = m.anchors[3]!;
    expect(a.kind).toBe('smooth');
    expect(collinear(a.hin, a.hout)).toBe(true);
    expect(len(a.hin)).toBeCloseTo(8, 9);
    const b = moveHandle(square, 3, 'out', [10, 50], true).anchors[3]!;
    expect(b.kind).toBe('corner');
    expect(b.hin).toEqual([8, 0]);
  });

  it('bends a segment through the cursor, keeping smooth ends smooth', () => {
    const b = bendSegment(square, 3, 0.5, [8, 50]);
    expect(dist(evaluate(segment(b, 3), 0.5), [8, 50])).toBeLessThan(1e-9);
    const a = b.anchors[3]!;
    expect(collinear(a.hin, a.hout)).toBe(true);
    // a straight side bent stays attached at its corners and becomes a curve
    const s = bendSegment(square, 0, 0.5, [20, -6]);
    expect(isStraight(segment(s, 0))).toBe(false);
    expect(dist(evaluate(segment(s, 0), 0.5), [20, -6])).toBeLessThan(1e-9);
  });

  it('toggles corner and smooth', () => {
    const c = toggleKind(square, 3);
    expect(c.anchors[3]!.kind).toBe('corner');
    const s = toggleKind(c, 3).anchors[3]!;
    expect(s.kind).toBe('smooth');
    expect(collinear(s.hin, s.hout)).toBe(true);
  });

  it('deletes a point and refits the gap to the trace, keeping smooth neighbours smooth', () => {
    const traced = presetFixture('combopliers').outline_mm;
    const path = refit(traced, 0.3);
    const n = path.anchors.length;
    // a point between two smooth ones
    const i = path.anchors.findIndex((a, k) => a.kind === 'smooth' && path.anchors[(k + n - 1) % n]!.kind === 'smooth'
      && path.anchors[(k + 1) % n]!.kind === 'smooth');
    expect(i).toBeGreaterThanOrEqual(0);
    const d = deleteAnchor(path, i, traced);
    expect(d.anchors).toHaveLength(n - 1);
    for (const k of [(i + n - 1) % n, i % (n - 1)]) {
      const a = d.anchors[k]!;
      expect(a.kind).toBe('smooth');
      if (len(a.hin) > 1e-9 && len(a.hout) > 1e-9) expect(Math.abs(a.hin[0] * a.hout[1] - a.hin[1] * a.hout[0]) / (len(a.hin) * len(a.hout))).toBeLessThan(1e-6);
    }
    expect(isValid(d)).toBe(true);
    // still close to the trace: one point fewer costs little
    const R = toRing(d);
    const off = Math.max(...traced.map((q) => Math.min(...R.map((r) => dist(r, q)))));
    expect(off).toBeLessThan(2);
    // a triangle keeps its three points
    const tri: BezierPath = { anchors: square.anchors.slice(0, 3) };
    expect(deleteAnchor(tri, 0, traced)).toBe(tri);
  });

  it('refits with fewer points as the tolerance grows', () => {
    const traced: Ring = presetFixture('needlenose').outline_mm;
    const fine = refit(traced, 0.15).anchors.length, coarse = refit(traced, 1).anchors.length;
    expect(coarse).toBeLessThan(fine);
    expect(isValid(refit(traced, 1))).toBe(true);
  });

  it('flags a path that crosses itself', () => {
    const crossed = moveAnchor(square, 1, [-10, 20], false);
    expect(isValid(crossed)).toBe(false);
    expect(isValid(square)).toBe(true);
  });
});

describe('rounding a corner', () => {
  it('turns a square corner into a tangent arc of the radius', () => {
    const { path: r, radius } = roundCorner(square, 1, 5); // the corner at (40, 0)
    expect(radius).toBeCloseTo(5, 9);
    expect(r.anchors).toHaveLength(square.anchors.length + 1);
    const [a, b] = [r.anchors[1]!, r.anchors[2]!];
    expect(a.p[0]).toBeCloseTo(35, 6);
    expect(a.p[1]).toBeCloseTo(0, 6);
    expect(b.p[0]).toBeCloseTo(40, 6);
    expect(b.p[1]).toBeCloseTo(5, 6);
    expect([a.kind, b.kind]).toEqual(['smooth', 'smooth']);
    // every point of the arc is 5 mm from the fillet's centre (35, 5), to within a cubic's error
    const c = segment(r, 1);
    for (let k = 0; k <= 20; k++) expect(dist(evaluate(c, k / 20), [35, 5])).toBeCloseTo(5, 2);
    // the sides stay straight up to the arc
    expect(isStraight(segment(r, 0))).toBe(true);
    expect(isStraight(segment(r, 2))).toBe(true);
    expect(isValid(r)).toBe(true);
  });

  it('rounds as much as fits, and leaves a point that barely turns', () => {
    // 30 mm needs 30 mm of each 40 mm side; 45% of it (18 mm) fits
    const big = roundCorner(square, 1, 30);
    expect(big.radius).toBeCloseTo(18, 6);
    expect(isValid(big.path)).toBe(true);
    const flat = refit(presetFixture('needlenose').outline_mm, 0.3);
    const smoothIdx = flat.anchors.findIndex((x, k) => k > 0 && x.kind === 'smooth' && Math.abs(x.hin[0] * x.hout[1] - x.hin[1] * x.hout[0]) < 1e-9);
    if (smoothIdx >= 0) expect(roundCorner(flat, smoothIdx, 2)).toEqual({ path: flat, radius: 0 });
  });
});
