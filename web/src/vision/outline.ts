// Mask to upright tool outline. Mirrors build_assets / UprightToSheet in src/gts/trace.py:
// largest contour, minAreaRect turned so the long axis is vertical, rotate with an expanded canvas,
// crop to the tool + 12 mm, smooth the contour and centre it on the crop.
import type { Ring, Vec2 } from '../geometry/pocket';
import { getCv, type CV } from './opencv';
import { smoothClosed } from './smooth';

/** A single-channel 0-255 mask (row-major, `width * height` bytes). */
export interface Mask {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** 2x3 affine [A | b]: `p' = A @ p + b`. */
export type Affine = [[number, number, number], [number, number, number]];

export interface UprightOutline {
  /** The tool's upright outline in mm, centred on the crop centre (720 points, last repeats the first). */
  outline: Ring;
  /** Width and height of the upright crop in mm. */
  crop: [number, number];
  /** Upright-centred outline mm to sheet mm. */
  up2sheet: Affine;
}

export interface RotatedRect {
  centre: Vec2;
  size: [number, number];
  angle: number;
}

/** Largest external contour (by area) of `mat` thresholded at > 128, as an owned CV_32SC2 Mat. */
function largestContour(cv: CV, mat: CV): CV {
  const bin = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.threshold(mat, bin, 128, 1, cv.THRESH_BINARY);
    cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    let best = -1;
    let bestArea = -Infinity;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      c.delete();
      if (a > bestArea) {
        best = i;
        bestArea = a;
      }
    }
    if (best < 0) throw new Error('The mask has no tool in it.');
    return contours.get(best);
  } finally {
    bin.delete();
    contours.delete();
    hierarchy.delete();
  }
}

function minAreaRect(cv: CV, contour: CV): RotatedRect {
  const f = new cv.Mat();
  try {
    contour.convertTo(f, cv.CV_32F);
    const r = cv.minAreaRect(f);
    return { centre: [r.center.x, r.center.y], size: [r.size.width, r.size.height], angle: r.angle };
  } finally {
    f.delete();
  }
}

/** Largest contour of a mask and its cv.minAreaRect, in mask pixels (for tests and diagnostics). */
export async function maskRect(mask: Mask): Promise<RotatedRect> {
  const cv = await getCv();
  const mat = cv.matFromArray(mask.height, mask.width, cv.CV_8UC1, mask.data);
  try {
    const c = largestContour(cv, mat);
    try {
      return minAreaRect(cv, c);
    } finally {
      c.delete();
    }
  } finally {
    mat.delete();
  }
}

/** Upright outline, crop size and upright-to-sheet transform from a mask at `pxPerMm` whose
 * pixel (0, 0) sits at `originMm` on the sheet. */
export async function outlineFromMask(mask: Mask, originMm: Vec2, pxPerMm: number): Promise<UprightOutline> {
  const cv = await getCv();
  const owned: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T) => (owned.push(x), x);
  try {
    const src = keep(cv.matFromArray(mask.height, mask.width, cv.CV_8UC1, mask.data));
    const rect = minAreaRect(cv, keep(largestContour(cv, src)));
    const [cx, cy] = rect.centre;
    const ang = rect.size[0] > rect.size[1] ? rect.angle + 90 : rect.angle;
    // cv2.getRotationMatrix2D, then shifted onto an expanded canvas
    const t = (ang * Math.PI) / 180;
    const a = Math.cos(t);
    const b = Math.sin(t);
    const W0 = mask.width;
    const H0 = mask.height;
    const nW = Math.trunc(H0 * Math.abs(b) + W0 * Math.abs(a));
    const nH = Math.trunc(H0 * Math.abs(a) + W0 * Math.abs(b));
    const M: Affine = [
      [a, b, (1 - a) * cx - b * cy + nW / 2 - cx],
      [-b, a, b * cx + (1 - a) * cy + nH / 2 - cy],
    ];
    const Mm = keep(cv.matFromArray(2, 3, cv.CV_64F, M.flat()));
    const up = keep(new cv.Mat());
    cv.warpAffine(src, up, Mm, new cv.Size(nW, nH), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
    const box = cv.boundingRect(keep(largestContour(cv, up)));
    const pad = Math.trunc(12 * pxPerMm);
    const x0 = Math.max(0, box.x - pad);
    const y0 = Math.max(0, box.y - pad);
    const x1 = Math.min(nW, box.x + box.width + pad);
    const y1 = Math.min(nH, box.y + box.height + pad);
    const crop = keep(up.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0)));
    const c = keep(largestContour(cv, crop));
    const pts: Vec2[] = [];
    for (let i = 0; i < c.data32S.length; i += 2) pts.push([c.data32S[i], c.data32S[i + 1]]);
    const cw = (x1 - x0) / pxPerMm;
    const ch = (y1 - y0) / pxPerMm;
    const outline = smoothClosed(pts, 2.0).map(([x, y]): Vec2 => [x / pxPerMm - cw / 2, y / pxPerMm - ch / 2]);
    return { outline, crop: [cw, ch], up2sheet: uprightToSheet(M, cw, ch, x0, y0, originMm, pxPerMm) };
  } finally {
    for (const x of owned) x.delete();
  }
}

/** The affine form of gts.trace.UprightToSheet: undo the crop offset, the rotation M and the canvas origin. */
function uprightToSheet(M: Affine, cw: number, ch: number, x0: number, y0: number, origin: Vec2, px: number): Affine {
  const [[a, b, c], [d, e, f]] = M;
  const det = a * e - b * d;
  // inverse of the 2x2 part and its translation (cv2.invertAffineTransform)
  const ia = e / det;
  const ib = -b / det;
  const id = -d / det;
  const ie = a / det;
  const ic = -(ia * c + ib * f);
  const iff = -(id * c + ie * f);
  // sheet = (Minv @ ((q + crop/2) * px + (x0, y0))) / px + origin
  const ox = (cw / 2) * px + x0;
  const oy = (ch / 2) * px + y0;
  return [
    [ia, ib, (ia * ox + ib * oy + ic) / px + origin[0]],
    [id, ie, (id * ox + ie * oy + iff) / px + origin[1]],
  ];
}
