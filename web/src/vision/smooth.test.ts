import { describe, expect, it } from 'vitest';
import type { Ring } from '../geometry/pocket';
import { resample, smoothClosed } from './smooth';

describe('resample', () => {
  it('spaces points evenly by arc length around a closed ring', () => {
    const square: Ring = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const R = resample(square, 8);
    expect(R).toEqual([[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5]]);
  });
});

describe('smoothClosed', () => {
  it('matches scipy splprep(s=2n, per=1) on a pixel circle', () => {
    const pts: Ring = [];
    for (let i = 0; i < 2000; i++) {
      const t = (2 * Math.PI * i) / 2000;
      pts.push([Math.round(300 + 200 * Math.cos(t)), Math.round(300 + 200 * Math.sin(t))]);
    }
    const S = smoothClosed(pts, 2.0);
    expect(S).toHaveLength(720);
    expect(S[719]![0]).toBeCloseTo(S[0]![0], 9);
    expect(S[719]![1]).toBeCloseTo(S[0]![1], 9);
    // gts.geometry.spline on the same points (scipy 1.x): S[0], S[100]
    expect(Math.hypot(S[0]![0] - 501.7452, S[0]![1] - 300.3345)).toBeLessThan(0.01);
    expect(Math.hypot(S[100]![0] - 427.4675, S[100]![1] - 453.2066)).toBeLessThan(0.01);
    for (const [x, y] of S) expect(Math.abs(Math.hypot(x - 300, y - 300) - 200)).toBeLessThan(3);
  });
});
