import { describe, expect, it } from 'vitest';
import { rotate, signedArea, type Ring, type Vec2 } from '../geometry/pocket';
import { resample } from './smooth';
import { straighten } from './straighten';

/** A deterministic pseudo-random sequence in [-1, 1]. */
function noise(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s / 2147483647) * 2 - 1;
  };
}

/** A w x h rectangle with corner radius r, 720 points, closed (last repeats first), centred on the origin. */
function roundedRect(w: number, h: number, r: number): Ring {
  const pts: Vec2[] = [];
  const corners: [number, number, number][] = [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180], [w / 2 - r, -h / 2 + r, 270]];
  for (const [cx, cy, a0] of corners) {
    for (let k = 0; k <= 16; k++) {
      const a = ((a0 + (k / 16) * 90) * Math.PI) / 180;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  const R = resample(pts, 720);
  return [...R.slice(0, 720), R[0]!];
}

/** `P` with wobble of amplitude `amp` mm along its outward normals (a few bumps per 10 mm). */
function wobble(P: Ring, amp: number, seed = 7): Ring {
  const rnd = noise(seed);
  const n = P.length - 1;
  const out = P.slice(0, n).map((p, k): Vec2 => {
    const a = P[(k + n - 1) % n]!, b = P[(k + 1) % n]!;
    const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
    const e = amp * (0.6 * Math.sin(k * 0.9) + 0.4 * rnd());
    return [p[0] + (ty / l) * e, p[1] - (tx / l) * e];
  });
  return [...out, out[0]!];
}

/** Points of `P` within `band` mm of the line x = `x0` (for a vertical side), between y0 and y1. */
const side = (P: Ring, x0: number, y0: number, y1: number, band = 2) =>
  P.filter(([x, y]) => Math.abs(x - x0) < band && y > y0 && y < y1);

/** Whether point q lies inside (or within eps of) the closed ring P. */
function inside(P: Ring, [x, y]: Vec2, eps = 1e-6): boolean {
  let c = false;
  for (let i = 0, j = P.length - 2; i < P.length - 1; j = i++) {
    const [xi, yi] = P[i]!, [xj, yj] = P[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    // on the edge
    const dx = xj - xi, dy = yj - yi, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / l2));
    if (Math.hypot(xi + t * dx - x, yi + t * dy - y) < eps) return true;
  }
  return c;
}

describe('straighten', () => {
  const box = roundedRect(75, 131, 3);

  it('makes the wobbly sides of a box straight and square, and keeps its corners round', () => {
    const traced = wobble(box, 0.4);
    const S = straighten(traced);
    expect(S).toHaveLength(traced.length);
    expect(S[0]).toEqual(S[S.length - 1]);
    for (const [x0, sign] of [[-37.5, -1], [37.5, 1]] as const) {
      const xs = side(S, x0, -55, 55).map((p) => p[0]);
      expect(xs.length).toBeGreaterThan(100);
      // one exact vertical line, at the outermost traced point
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1e-9);
      const tracedXs = side(traced, x0, -55, 55).map((p) => p[0]);
      expect(xs[0]).toBeCloseTo(sign > 0 ? Math.max(...tracedXs) : Math.min(...tracedXs), 9);
    }
    // the corners are not cut: still about radius 3 from the corner centres
    const corner = S.filter(([x, y]) => x > 34.5 && y > 62.5);
    for (const [x, y] of corner) expect(Math.hypot(x - 34.5, y - 62.5)).toBeLessThan(3.6);
  });

  it('holds the traced outline: every traced point is inside the straightened one', () => {
    const traced = wobble(box, 0.5, 3);
    const S = straighten(traced);
    for (const p of traced) expect(inside(S, p, 1e-6)).toBe(true);
  });

  it('squares a side a fraction of a degree off the axis, and keeps a side a degree off at its own angle', () => {
    const left = (S: Ring) => S.filter(([x, y]) => x < -35 && Math.abs(y) < 50);
    const squared = left(straighten(rotate(wobble(box, 0.3), 0.3))).map((p) => p[0]);
    expect(Math.max(...squared) - Math.min(...squared)).toBeLessThan(1e-9);
    // 1 degree over 131 mm is 2.3 mm: too far to square without cutting in, so the side stays tilted but straight
    const tilted = left(straighten(rotate(wobble(box, 0.3), 1)));
    const [a, b] = [tilted[0]!, tilted[tilted.length - 1]!];
    const off = tilted.map(([x, y]) => Math.abs((b[0] - a[0]) * (a[1] - y) - (a[0] - x) * (b[1] - a[1])) / Math.hypot(b[0] - a[0], b[1] - a[1]));
    expect(Math.max(...off)).toBeLessThan(1e-6);
    expect(Math.abs(Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI)).toBeGreaterThan(0.5);
  });

  it('leaves curves alone: a circle and a gentle 150 mm arc', () => {
    const circle = resample(Array.from({ length: 360 }, (_, k): Vec2 => [20 * Math.cos((k * Math.PI) / 180), 20 * Math.sin((k * Math.PI) / 180)]), 720);
    expect(straighten(circle)).toEqual(circle);
    // a lens: two 150 mm arcs meeting at points 60 mm apart
    const lens: Vec2[] = [];
    const R = 150, half = Math.asin(30 / R);
    for (let k = 0; k <= 200; k++) {
      const a = -half + (2 * half * k) / 200;
      lens.push([R * Math.sin(a), R * Math.cos(a) - R * Math.cos(half)]);
    }
    for (let k = 0; k <= 200; k++) {
      const a = half - (2 * half * k) / 200;
      lens.push([R * Math.sin(a), -(R * Math.cos(a) - R * Math.cos(half))]);
    }
    const L = resample(lens, 720);
    expect(straighten(L)).toEqual(L);
  });

  it('straightens a side the mask bows gently (0.4 mm over 100 mm), but not a 250 mm arc', () => {
    const bow = (P: Ring, sag: number) => {
      const n = P.length - 1;
      const out = P.slice(0, n).map(([x, y]): Vec2 => (x > 36 && Math.abs(y) < 50 ? [x + sag * (1 - (y / 50) ** 2), y] : [x, y]));
      return [...out, out[0]!];
    };
    const right = (S: Ring) => S.filter(([x, y]) => x > 36 && Math.abs(y) < 48).map((p) => p[0]);
    const bowed = right(straighten(bow(box, 0.4)));
    expect(Math.max(...bowed) - Math.min(...bowed)).toBeLessThan(1e-9);
    // a 250 mm radius arc of the same 100 mm span bows 5 mm: a real curve, left alone
    const arc = bow(box, 5);
    expect(right(straighten(arc))).toEqual(right(arc));
  });

  it('keeps the orientation and size of the ring', () => {
    const traced = wobble(box, 0.4);
    const S = straighten(traced);
    expect(Math.sign(signedArea(S))).toBe(Math.sign(signedArea(traced)));
    expect(Math.abs(signedArea(S))).toBeGreaterThanOrEqual(Math.abs(signedArea(traced)) - 1e-6);
  });
});
