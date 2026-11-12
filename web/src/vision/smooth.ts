// Periodic smoothing of closed contours. Mirrors spline() and resample() in src/gts/geometry.py,
// which use scipy's splprep(per=1), i.e. FITPACK clocur/fpclos. This is a port of that algorithm
// (same parameterisation, knot placement and smoothing criterion), so the knots match scipy's and the
// curve matches to a few micrometres; the linear algebra is dense normal equations instead of Givens.
import type { Ring, Vec2 } from '../geometry/pocket';

const K = 3; // cubic

/** Resample a closed ring (no closing point) to `n` points evenly spaced by arc length. */
export function resample(ring: readonly Vec2[], n = 720): Ring {
  const m = ring.length;
  const s = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % m]!;
    s[i + 1] = s[i]! + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const total = s[m]!;
  const out: Ring = [];
  let j = 0;
  for (let q = 0; q < n; q++) {
    const u = (total * q) / n;
    while (j < m - 1 && s[j + 1]! <= u) j++;
    const a = ring[j]!;
    const b = ring[(j + 1) % m]!;
    const d = s[j + 1]! - s[j]!;
    const f = d > 0 ? (u - s[j]!) / d : 0;
    out.push([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]);
  }
  return out;
}

/** The four nonzero cubic B-splines at x in [t[l], t[l+1]) (indices l-3..l); Cox-de Boor as FITPACK fpbspl. */
function bspl(t: Float64Array, l: number, x: number): [number, number, number, number] {
  const h = [1, 0, 0, 0];
  const hh = [0, 0, 0];
  for (let j = 1; j <= K; j++) {
    for (let i = 0; i < j; i++) hh[i] = h[i]!;
    h[0] = 0;
    for (let i = 1; i <= j; i++) {
      const li = l + i;
      const lj = li - j;
      const f = hh[i - 1]! / (t[li]! - t[lj]!);
      h[i - 1]! += f * (t[li]! - x);
      h[i] = f * (x - t[lj]!);
    }
  }
  return h as [number, number, number, number];
}

/** A periodic cubic spline on [u0, u1]: `L` knot intervals, the extended knot vector and L coefficients per dim. */
interface PeriodicSpline {
  t: Float64Array;
  L: number;
  cx: Float64Array;
  cy: Float64Array;
}

/** Knot vector t[0..L+2K]: t[K] = u0, interior knots, t[K+L] = u1, extended by the period. */
function periodicKnots(u0: number, u1: number, interior: readonly number[]): { t: Float64Array; L: number } {
  const inner = [u0, ...interior, u1];
  const L = inner.length - 1;
  const per = u1 - u0;
  const t = new Float64Array(L + 2 * K + 1);
  for (let i = -K; i <= L + K; i++) {
    const q = Math.floor(i / L);
    t[i + K] = inner[i - q * L]! + per * q;
  }
  return { t, L };
}

/** Index of the knot interval [t[l], t[l+1]) holding x, searching up from `l`. */
function interval(t: Float64Array, L: number, x: number, l: number): number {
  while (l < K + L - 1 && x >= t[l + 1]!) l++;
  return l;
}

/** Solve the symmetric positive definite system M c = r (dense, size n) by Cholesky. */
function cholSolve(M: Float64Array, n: number, rhs: Float64Array[]): Float64Array[] {
  const C = Float64Array.from(M);
  for (let j = 0; j < n; j++) {
    let d = C[j * n + j]!;
    for (let k = 0; k < j; k++) d -= C[j * n + k]! ** 2;
    if (!(d > 0)) throw new Error('Smoothing system is not positive definite.');
    const piv = Math.sqrt(d);
    C[j * n + j] = piv;
    for (let i = j + 1; i < n; i++) {
      let v = C[i * n + j]!;
      for (let k = 0; k < j; k++) v -= C[i * n + k]! * C[j * n + k]!;
      C[i * n + j] = v / piv;
    }
  }
  return rhs.map((r) => {
    const y = Float64Array.from(r);
    for (let i = 0; i < n; i++) {
      let v = y[i]!;
      for (let k = 0; k < i; k++) v -= C[i * n + k]! * y[k]!;
      y[i] = v / C[i * n + i]!;
    }
    for (let i = n - 1; i >= 0; i--) {
      let v = y[i]!;
      for (let k = i + 1; k < n; k++) v -= C[k * n + i]! * y[k]!;
      y[i] = v / C[i * n + i]!;
    }
    return y;
  });
}

/** Normal equations of the periodic least-squares fit: rows of the design matrix (4 nonzeros each). */
class Design {
  readonly idx: Int32Array;
  readonly val: Float64Array;
  readonly AtA: Float64Array;
  readonly Atx: Float64Array;
  readonly Aty: Float64Array;

  constructor(readonly t: Float64Array, readonly L: number, u: Float64Array, readonly X: readonly Vec2[]) {
    const m1 = X.length;
    this.idx = new Int32Array(m1 * (K + 1));
    this.val = new Float64Array(m1 * (K + 1));
    this.AtA = new Float64Array(L * L);
    this.Atx = new Float64Array(L);
    this.Aty = new Float64Array(L);
    let l = K;
    for (let it = 0; it < m1; it++) {
      l = interval(t, L, u[it]!, l);
      const h = bspl(t, l, u[it]!);
      for (let i = 0; i <= K; i++) {
        this.idx[it * 4 + i] = (l - K + i) % L;
        this.val[it * 4 + i] = h[i]!;
      }
      for (let i = 0; i <= K; i++) {
        const a = this.idx[it * 4 + i]!;
        const va = h[i]!;
        this.Atx[a]! += va * X[it]![0];
        this.Aty[a]! += va * X[it]![1];
        for (let j = 0; j <= K; j++) this.AtA[a * L + this.idx[it * 4 + j]!]! += va * h[j]!;
      }
    }
  }

  /** Squared residual of every data point for coefficients (cx, cy). */
  residuals(cx: Float64Array, cy: Float64Array): Float64Array {
    const m1 = this.X.length;
    const r = new Float64Array(m1);
    for (let it = 0; it < m1; it++) {
      let x = 0;
      let y = 0;
      for (let i = 0; i <= K; i++) {
        const a = this.idx[it * 4 + i]!;
        x += this.val[it * 4 + i]! * cx[a]!;
        y += this.val[it * 4 + i]! * cy[a]!;
      }
      r[it] = (x - this.X[it]![0]) ** 2 + (y - this.X[it]![1]) ** 2;
    }
    return r;
  }
}

const sum = (a: Float64Array) => a.reduce((s, v) => s + v, 0);

/** Jumps of the third derivative of every periodic B-spline at the interior knots (FITPACK fpdisc, unscaled). */
function discontinuities(t: Float64Array, L: number): Float64Array {
  const BtB = new Float64Array(L * L);
  for (let l = K + 1; l < K + L; l++) {
    const row = new Float64Array(L);
    for (let j = l - K - 1; j <= l; j++) {
      let prod = 1;
      for (let i = j; i <= j + K + 1; i++) if (i !== l) prod *= t[l]! - t[i]!;
      row[j % L]! += (t[j + K + 1]! - t[j]!) / prod;
    }
    for (let a = 0; a < L; a++) for (let b = 0; b < L; b++) BtB[a * L + b]! += row[a]! * row[b]!;
  }
  return BtB;
}

/** Periodic cubic smoothing spline of the closed curve X (X[last] is overwritten by X[0], as scipy does)
 * with smoothing factor s: FITPACK fpclos with tol 0.001. */
function clocur(X0: readonly Vec2[], s: number): PeriodicSpline {
  const X = X0.slice(0, -1);
  const m = X0.length;
  const m1 = m - 1;
  const closed = [...X, X[0]!];
  const u = new Float64Array(m);
  for (let i = 1; i < m; i++) u[i] = u[i - 1]! + Math.hypot(closed[i]![0] - closed[i - 1]![0], closed[i]![1] - closed[i - 1]![1]);
  const total = u[m1]!;
  for (let i = 1; i < m; i++) u[i] = u[i]! / total;
  u[m1] = 1;
  const acc = 0.001 * s;

  let mx = 0;
  let my = 0;
  for (const p of X) {
    mx += p[0] / m1;
    my += p[1] / m1;
  }
  const fp0 = X.reduce((a, p) => a + (p[0] - mx) ** 2 + (p[1] - my) ** 2, 0);
  if (fp0 - s < acc) {
    const { t, L } = periodicKnots(0, 1, []);
    return { t, L, cx: Float64Array.of(mx), cy: Float64Array.of(my) };
  }

  // grow the knot set until the least-squares spline is within s (fpclos knot loop)
  const mm = Math.floor((m + 1) / 2);
  const interior = [u[mm - 1]!];
  let nrdata = [mm - 2, m1 - mm];
  let nplus = 1;
  let fpold = fp0;
  let design: Design;
  let cx: Float64Array;
  let cy: Float64Array;
  for (;;) {
    const { t, L } = periodicKnots(0, 1, interior);
    design = new Design(t, L, u, X);
    [cx, cy] = cholSolve(design.AtA, L, [design.Atx, design.Aty]) as [Float64Array, Float64Array];
    const R = design.residuals(cx, cy);
    const fp = sum(R);
    const fpms = fp - s;
    if (Math.abs(fpms) < acc) return { t, L, cx, cy };
    if (fpms < 0) break;
    let npl1 = nplus * 2;
    if (fpold - fp > acc) npl1 = Math.trunc((nplus * fpms) / (fpold - fp));
    nplus = Math.min(nplus * 2, Math.max(npl1, Math.trunc(nplus / 2), 1));
    fpold = fp;
    // residual sum per knot interval; a point on a knot counts half to each side, the first point to
    // both the first and the last interval (as fpclos does)
    const fpint = new Array<number>(L).fill(0);
    let i = 0;
    let fpart = 0;
    let kn = 0;
    for (let it = 0; it < m1; it++) {
      const r = R[it]!;
      fpart += r;
      if (it === 0) {
        fpint[L - 1] = r;
        continue;
      }
      if (kn < interior.length && u[it]! >= interior[kn]!) {
        kn++;
        fpint[i++] = fpart - r / 2;
        fpart = r / 2;
      }
    }
    fpint[L - 1]! += fpart;
    // fpknot: split the interval with the largest residual sum at its middle data point
    let grew = false;
    for (let add = 0; add < nplus; add++) {
      let fpmax = 0;
      let jbegin = 0;
      let number = -1;
      let maxpt = 0;
      let maxbeg = 0;
      for (let j = 0; j < fpint.length; j++) {
        if (!(fpmax >= fpint[j]! || nrdata[j] === 0)) {
          fpmax = fpint[j]!;
          number = j;
          maxpt = nrdata[j]!;
          maxbeg = jbegin;
        }
        jbegin += nrdata[j]! + 1;
      }
      if (number < 0) break;
      const ihalf = Math.trunc(maxpt / 2) + 1;
      nrdata = [...nrdata.slice(0, number), ihalf - 1, maxpt - ihalf, ...nrdata.slice(number + 1)];
      fpint.splice(number, 1, (fpmax * (ihalf - 1)) / maxpt, (fpmax * (maxpt - ihalf)) / maxpt);
      interior.splice(number, 0, u[maxbeg + ihalf]!);
      grew = true;
    }
    if (!grew) break;
  }

  // smoothing phase: minimise the third-derivative jumps subject to fp(lambda) = s
  const { t, L, AtA, Atx, Aty } = design;
  const BtB = discontinuities(t, L);
  let trA = 0;
  let trB = 0;
  for (let a = 0; a < L; a++) {
    trA += AtA[a * L + a]!;
    trB += BtB[a * L + a]!;
  }
  const scale = trA / trB;
  const solve = (lg: number) => {
    const M = Float64Array.from(AtA);
    const lam = 10 ** lg * scale;
    for (let a = 0; a < L * L; a++) M[a]! += lam * BtB[a]!;
    const [sx, sy] = cholSolve(M, L, [Atx, Aty]) as [Float64Array, Float64Array];
    return { sx, sy, fp: sum(design.residuals(sx, sy)) };
  };
  let lo = -12;
  let hi = 12; // fp grows with lambda
  for (let iter = 0; iter < 200; iter++) {
    const mid = (lo + hi) / 2;
    const { sx, sy, fp } = solve(mid);
    cx = sx;
    cy = sy;
    if (Math.abs(fp - s) < acc * 1e-3) break;
    if (fp > s) hi = mid;
    else lo = mid;
  }
  return { t, L, cx, cy };
}

/** Points of a periodic spline at `n` parameters evenly spaced over [0, 1] (both ends included, as splev). */
function evaluate({ t, L, cx, cy }: PeriodicSpline, n: number): Ring {
  const out: Ring = [];
  for (let q = 0; q < n; q++) {
    const x = n > 1 ? q / (n - 1) : 0;
    const l = interval(t, L, x, K);
    const h = bspl(t, l, x);
    let px = 0;
    let py = 0;
    for (let i = 0; i <= K; i++) {
      px += h[i]! * cx[(l - K + i) % L]!;
      py += h[i]! * cy[(l - K + i) % L]!;
    }
    out.push([px, py]);
  }
  return out;
}

/** Resample a closed contour by arc length and fit a periodic smoothing spline with `n` points
 * (smoothing factor `n * sf`), like gts.geometry.spline. The last point repeats the first. */
export function smoothClosed(C: readonly Vec2[], sf = 2.0, n = 720): Ring {
  const R = resample(C, n);
  return evaluate(clocur(R, R.length * sf), n);
}
