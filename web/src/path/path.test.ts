import { describe, expect, it } from 'vitest';
import { signedArea, type Ring, type Vec2 } from '../geometry/pocket';
import { hausdorff, presetFixture, TOOLS } from '../test/fixtures';
import { resample } from '../vision/smooth';
import { straighten } from '../vision/straighten';
import {
  dist, evaluate, flatten, flattenCubic, insertAnchor, isStraight, makeSmooth, nearest, segment, split,
  straightenSegment, type BezierPath, type Cubic,
} from './bezier';
import { fitCubics, fitOutline } from './fit';
import { checkRing, toRing } from './ring';

const C: Cubic = [[0, 0], [10, 30], [40, -20], [50, 10]];

/** Distance from q to the closed polyline P. */
function toPolyline(P: Ring, q: Vec2): number {
  let best = Infinity;
  for (let i = 0; i < P.length; i++) {
    const a = P[i]!, b = P[(i + 1) % P.length]!;
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2));
    best = Math.min(best, Math.hypot(a[0] + t * dx - q[0], a[1] + t * dy - q[1]));
  }
  return best;
}

function inside(P: Ring, [x, y]: Vec2): boolean {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i]!, [xj, yj] = P[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** How far the traced points stick out of the ring `R` (mm): how far R runs inside the trace. */
const inward = (traced: Ring, R: Ring) => Math.max(0, ...traced.filter((q) => !inside(R, q)).map((q) => toPolyline(R, q)));

const closed = (pts: Vec2[]): Ring => [...pts, pts[0]!];
const circle = (r: number, n = 720): Ring => closed(Array.from({ length: n - 1 }, (_, k): Vec2 => [r * Math.cos((2 * Math.PI * k) / (n - 1)), r * Math.sin((2 * Math.PI * k) / (n - 1))]));
/** A w x h rectangle (sharp corners), densely sampled, counter-clockwise. */
const rect = (w: number, h: number): Ring => closed(resample([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], 719).slice(0, 719));

describe('cubic Bézier maths', () => {
  it('splits a cubic into two that trace the same curve', () => {
    const [l, r] = split(C, 0.3);
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      const a = evaluate(l, t), b = evaluate(C, 0.3 * t);
      expect(dist(a, b)).toBeLessThan(1e-9);
      expect(dist(evaluate(r, t), evaluate(C, 0.3 + 0.7 * t))).toBeLessThan(1e-9);
    }
  });

  it('inserts an anchor without changing the shape: smooth on a curve, a corner on a straight segment', () => {
    const path: BezierPath = { anchors: [
      { p: [0, 0], hin: [0, 0], hout: [10, 30], kind: 'corner' },
      { p: [50, 10], hin: [-10, 30], hout: [0, 0], kind: 'corner' },
      { p: [25, -30], hin: [0, 0], hout: [0, 0], kind: 'corner' },
    ] };
    const { path: q, index } = insertAnchor(path, 0, 0.4);
    expect(q.anchors).toHaveLength(4);
    const a = q.anchors[index]!;
    expect(a.kind).toBe('smooth');
    expect(Math.abs(a.hin[0] * a.hout[1] - a.hin[1] * a.hout[0])).toBeLessThan(1e-9); // collinear
    expect(hausdorff(flatten(q, 0.005).points, flatten(path, 0.005).points)).toBeLessThan(0.02);
    const { path: s, index: j } = insertAnchor(path, 1, 0.5);
    expect(s.anchors[j]).toMatchObject({ kind: 'corner', hin: [0, 0], hout: [0, 0] });
  });

  it('finds the nearest point on a path', () => {
    const path: BezierPath = { anchors: [
      { p: [0, 0], hin: [0, 0], hout: [10, 30], kind: 'corner' },
      { p: [50, 10], hin: [-10, 30], hout: [0, 0], kind: 'corner' },
    ] };
    const on = evaluate(segment(path, 0), 0.37);
    expect(nearest(path, on).dist).toBeLessThan(1e-6);
    const r = nearest(path, [25, 60]);
    for (let k = 0; k <= 200; k++) expect(dist(evaluate(segment(path, 0), k / 200), [25, 60])).toBeGreaterThanOrEqual(r.dist - 1e-6);
  });

  it('flattens a cubic to within the tolerance', () => {
    const P = [...flattenCubic(C, 0.02), C[3]];
    for (let k = 0; k <= 400; k++) {
      const q = evaluate(C, k / 400);
      let d = Infinity;
      for (let i = 0; i + 1 < P.length; i++) d = Math.min(d, toPolyline([P[i]!, P[i + 1]!], q));
      expect(d).toBeLessThanOrEqual(0.02 + 1e-9);
    }
  });

  it('makes an anchor smooth (collinear handles) and a segment straight', () => {
    const path: BezierPath = { anchors: [
      { p: [0, 0], hin: [0, 0], hout: [5, 0], kind: 'corner' },
      { p: [20, 10], hin: [0, -6], hout: [4, 0], kind: 'corner' },
      { p: [40, 0], hin: [-5, 0], hout: [0, 0], kind: 'corner' },
    ] };
    const s = makeSmooth(path, 1).anchors[1]!;
    expect(s.kind).toBe('smooth');
    expect(Math.abs(s.hin[0] * s.hout[1] - s.hin[1] * s.hout[0])).toBeLessThan(1e-9);
    expect(s.hin[0] * s.hout[0] + s.hin[1] * s.hout[1]).toBeLessThan(0); // opposite sides
    expect(isStraight(segment(straightenSegment(path, 0), 0))).toBe(true);
  });
});

describe('Schneider fitting', () => {
  it('fits an open run of points within the tolerance', () => {
    const pts: Vec2[] = Array.from({ length: 200 }, (_, k) => [k * 0.5, 10 * Math.sin(k * 0.04)]);
    const n = pts.length;
    const cubics = fitCubics(pts, 0.1 ** 2, [pts[1]![0] - pts[0]![0], pts[1]![1] - pts[0]![1]], [pts[n - 2]![0] - pts[n - 1]![0], pts[n - 2]![1] - pts[n - 1]![1]]);
    expect(cubics.length).toBeLessThan(8);
    for (const q of pts) {
      let d = Infinity;
      for (const c of cubics) for (let k = 0; k <= 200; k++) d = Math.min(d, dist(evaluate(c, k / 200), q));
      expect(d).toBeLessThan(0.12);
    }
  });
});

describe('fitting outlines and back', () => {
  /** Fit, flatten and check a traced outline; returns the fitted path. */
  function roundTrip(traced: Ring, maxAnchors: number): BezierPath {
    const path = fitOutline(traced);
    expect(path.anchors.length).toBeGreaterThan(2);
    expect(path.anchors.length).toBeLessThanOrEqual(maxAnchors);
    const R = toRing(path);
    expect(R).toHaveLength(720);
    expect(R[0]).toEqual(R[719]);
    // every anchor is on the ring
    for (const a of path.anchors) expect(R.some((q) => dist(q, a.p) < 1e-9)).toBe(true);
    expect(hausdorff(R, traced)).toBeLessThanOrEqual(0.35);
    expect(inward(traced, R)).toBeLessThanOrEqual(0.18);
    const check = checkRing(R);
    expect(check.crossings).toEqual([]);
    expect(check.ok).toBe(true);
    expect(Math.sign(check.area)).toBe(Math.sign(signedArea(traced)));
    return path;
  }

  it('a sharp rectangle: four corners joined by straight segments', () => {
    const path = roundTrip(straighten(rect(60, 30)), 4);
    expect(path.anchors.every((a) => a.kind === 'corner')).toBe(true);
    for (let i = 0; i < 4; i++) expect(isStraight(segment(path, i), 1e-6)).toBe(true);
  });

  it('a circle: a few smooth anchors', () => {
    const path = roundTrip(circle(20), 4);
    expect(path.anchors.every((a) => a.kind === 'smooth')).toBe(true);
  });

  it.each(TOOLS)('the %s outline, as traced and straightened', (tool) => {
    const traced = presetFixture(tool).outline_mm;
    roundTrip(traced, 60);
    roundTrip(straighten(traced), 60);
  });
});

describe('checkRing', () => {
  it('passes a simple ring and finds a figure-eight, a spike and a repeated point', () => {
    expect(checkRing(circle(10)).ok).toBe(true);
    const eight: Ring = closed([[0, 0], [10, 10], [10, 0], [0, 10]]);
    expect(checkRing(eight).crossings.length).toBeGreaterThan(0);
    const spike: Ring = closed([[0, 0], [10, 0], [10, 10], [5, 10], [5, 20], [5, 10.5], [0, 10]]);
    expect(checkRing(spike).spikes.length).toBeGreaterThan(0);
    const dup: Ring = closed([[0, 0], [10, 0], [10, 0], [10, 10], [0, 10]]);
    expect(checkRing(dup).zeroEdges).toEqual([1]);
  });
});
