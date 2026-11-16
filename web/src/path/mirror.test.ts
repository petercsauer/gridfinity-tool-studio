import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Ring, Vec2 } from '../geometry/pocket';
import { hausdorff, TOOLS } from '../test/fixtures';
import { dist, dot, len, type BezierPath } from './bezier';
import {
  constrainEnds, fitHalf, fullFromHalf, halfFromFull, isMirrored, mapAnchor, mirrorBend, mirrorDelete, mirrorInsert, mirrorMoveAnchor,
  mirrorMoveHandle, mirrorPoint, mirrorRound, mirrorStraighten, mirrorToggle, type Axis,
} from './mirror';
import { checkRing, toRing } from './ring';

const preset = (tool: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/web-presets/${tool}.json`, import.meta.url)), 'utf-8')) as
  { symmetric_outline_mm: Ring; symmetry_axis: Axis };

/** On the axis: as far from it as its own mirror image is, i.e. its own mirror. */
const onAxis = (a: Axis, p: Vec2) => dist(mirrorPoint(a, p), p) < 1e-6;
const smoothAt = (x: { hin: Vec2; hout: Vec2 }) => len(x.hin) > 1e-9 && len(x.hout) > 1e-9
  && Math.abs(x.hin[0] * x.hout[1] - x.hin[1] * x.hout[0]) / (len(x.hin) * len(x.hout)) < 1e-9 && dot(x.hin, x.hout) < 0;

describe('mirrored outlines', () => {
  const axis: Axis = { deg: 10, offset: 2, centre: [1, 3] };

  it('builds the whole outline from a half and back', () => {
    // ends put on the axis
    const half = constrainEnds(axis, { anchors: [
      { p: [3.0, -27.3], hin: [0, 0], hout: [5, 0], kind: 'corner' },
      { p: [20, 0], hin: [0, -6], hout: [0, 6], kind: 'smooth' },
      { p: [8.0, 31.2], hin: [6, 0], hout: [0, 0], kind: 'corner' },
    ] });
    const full = fullFromHalf(axis, half);
    expect(full.anchors).toHaveLength(4);
    expect(isMirrored(axis, full)).toBe(true);
    expect(halfFromFull(full)!.anchors.map((x) => x.p)).toEqual(half.anchors.map((x) => x.p));
    expect(halfFromFull({ anchors: full.anchors.slice(0, 3) })).toBeNull();
    expect(mapAnchor(3, 3)).toEqual({ j: 1, mirrored: true });
  });

  describe.each(TOOLS)('the %s symmetric outline', (tool) => {
    const { symmetric_outline_mm: traced, symmetry_axis: a } = preset(tool);
    const fit = fitHalf(a, traced, 0.3)!;

    it('fits a half whose mirror is the traced outline', () => {
      expect(fit).not.toBeNull();
      const { half } = fit;
      expect(onAxis(a, half.anchors[0]!.p)).toBe(true);
      expect(onAxis(a, half.anchors[half.anchors.length - 1]!.p)).toBe(true);
      const full = fullFromHalf(a, half);
      expect(isMirrored(a, full)).toBe(true);
      const R = toRing(full);
      expect(checkRing(R).ok).toBe(true);
      expect(hausdorff(R, traced)).toBeLessThanOrEqual(0.4);
      // a smooth end joins its mirror without a kink
      for (const x of [full.anchors[0]!, full.anchors[half.anchors.length - 1]!]) if (x.kind === 'smooth') expect(smoothAt(x)).toBe(true);
    });

    it('keeps it symmetric whichever side is edited', () => {
      const { half, ring } = fit;
      const n = 2 * half.anchors.length - 2;
      const full = fullFromHalf(a, half);
      // move point 2 on the original side, or its mirror on the other side to the mirrored place: the same edit
      const i = 2, to: Vec2 = [full.anchors[i]!.p[0] + 1.5, full.anchors[i]!.p[1] + 0.5];
      const one = mirrorMoveAnchor(a, half, i, to, false);
      const other = mirrorMoveAnchor(a, half, n - i, mirrorPoint(a, to), false);
      one.anchors.forEach((x, k) => expect(dist(x.p, other.anchors[k]!.p)).toBeLessThan(1e-9));
      const moved = fullFromHalf(a, one);
      expect(isMirrored(a, moved)).toBe(true);
      expect(dist(moved.anchors[i]!.p, to)).toBeLessThan(1e-9);
      expect(dist(moved.anchors[n - i]!.p, mirrorPoint(a, to))).toBeLessThan(1e-9);
      // every other edit too
      const edits: BezierPath[] = [
        mirrorMoveHandle(a, half, n - 3, 'out', mirrorPoint(a, [full.anchors[3]!.p[0] + 4, full.anchors[3]!.p[1] + 2])),
        mirrorBend(a, half, n - 2, 0.5, full.anchors[2]!.p),
        mirrorInsert(a, half, n - 3, 0.4).half,
        mirrorToggle(a, half, n - 2),
        mirrorStraighten(a, half, 1),
        mirrorRound(a, half, n - 2, 1).half,
        mirrorDelete(a, half, n - 2, ring)!,
      ];
      for (const e of edits) expect(isMirrored(a, fullFromHalf(a, e))).toBe(true);
    });

    it('keeps the points on the axis on it, and their smooth handles square to it', () => {
      const { half, ring } = fit;
      const h = half.anchors.length;
      // drag B off the axis: it slides along it
      const off = mirrorMoveAnchor(a, half, 0, [half.anchors[0]!.p[0] + 5, half.anchors[0]!.p[1] - 2]);
      expect(onAxis(a, off.anchors[0]!.p)).toBe(true);
      // a smooth T stays smooth when its handle is dragged, whichever of its two
      const smoothT = mirrorToggle(a, half, h - 1).anchors[h - 1]!.kind === 'smooth' ? mirrorToggle(a, half, h - 1) : half;
      const T = fullFromHalf(a, smoothT).anchors[h - 1]!;
      const dragged = fullFromHalf(a, mirrorMoveHandle(a, smoothT, h - 1, 'out', [T.p[0] + 3, T.p[1] + 7]));
      expect(smoothAt(dragged.anchors[h - 1]!)).toBe(true);
      // B and T can't be deleted or rounded
      expect(mirrorDelete(a, half, 0, ring)).toBeNull();
      expect(mirrorRound(a, half, h - 1, 2).radius).toBe(0);
    });

    it('adds a point and its mirror, and reports where', () => {
      const { half } = fit;
      const n = 2 * half.anchors.length - 2;
      const { half: more, index } = mirrorInsert(a, half, n - 2, 0.5);
      const full = fullFromHalf(a, more);
      expect(full.anchors).toHaveLength(n + 2);
      // the new point is on the side that was clicked
      expect(index).toBeGreaterThan(more.anchors.length - 1);
    });
  });

  it('declines an outline that crosses its axis more than twice', () => {
    // an hourglass of two discs side by side across a vertical axis: it crosses the axis four times
    const ring: Ring = [];
    for (let k = 0; k < 360; k++) {
      const t = (k * Math.PI) / 180, r = 10 + 6 * Math.cos(2 * t);
      ring.push([r * Math.sin(t) * 0.4, r * Math.cos(t)]);
    }
    const S: Ring = ring.map(([x, y]) => [x, y * (Math.abs(y) > 3 ? 1 : 1)]);
    // pinch the middle to the axis twice
    const pinched: Ring = S.map(([x, y]) => [Math.abs(y) < 2 ? x * 0 + (x > 0 ? 0.0 : 0.0) : x, y]);
    expect(fitHalf({ deg: 0, offset: 0, centre: [0, 0] }, [...pinched, pinched[0]!], 0.3)).toBeNull();
  });
});
