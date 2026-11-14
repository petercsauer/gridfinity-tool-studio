// Calibration sheet: ArUco marker detection, the photo-to-sheet-mm homography, region rectification and the
// sheet-view render, with opencv.js. Mirrors src/gts/sheet.py. Loads opencv.js, so import it only in the worker.
import { PipelineError } from '../worker/protocol';
import { getCv, type CV } from './opencv';

/** RGBA pixels, row-major; `ImageData` satisfies it. */
export interface RGBAImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type Point = [number, number];
/** The 4 corners of a marker in ArUco order: top-left, top-right, bottom-right, bottom-left. */
export type Corners = [Point, Point, Point, Point];
/** Row-major 3x3 homography from photo pixels to sheet mm. */
export type Homography = [[number, number, number], [number, number, number], [number, number, number]];
/** A sheet-mm rectangle [x0, y0, x1, y1]. */
export type Box = [number, number, number, number];

/** Marker metadata of the printed sheet (assets/sheet/sheet_markers.json, DICT_4X4_50; checked by the tests). */
export const SHEET = {
  /** Page size used for the search region: always the Letter entry. */
  pageMm: [215.9, 279.4] as Point,
  markerEdgeMm: 24,
  markers: {
    0: [[18, 22], [42, 22], [42, 46], [18, 46]],
    1: [[173.9, 22], [197.9, 22], [197.9, 46], [173.9, 46]],
    2: [[173.9, 233.4], [197.9, 233.4], [197.9, 257.4], [173.9, 257.4]],
    3: [[18, 233.4], [42, 233.4], [42, 257.4], [18, 257.4]],
  } as Record<number, Corners>,
};

/** The ArUco ids printed on the sheet. */
export const MARKER_IDS: readonly number[] = Object.keys(SHEET.markers).map(Number);

/** The sheet was not found in a photo; `missing` lists the absent marker ids. */
export class SheetError extends PipelineError {
  constructor(readonly missing: number[]) {
    const n = MARKER_IDS.length;
    super('invalid', `No calibration sheet detected (found ${n - missing.length} of ${n} markers; `
      + `missing ${missing.join(', ') || 'none'}). Photograph the tool on the printed calibration sheet with all `
      + 'four corner markers visible and not covered by the tool.');
    this.name = 'SheetError';
  }
}

export interface SheetDetection {
  H: Homography;
  /** Marker id to its corners in photo pixels. */
  corners: Map<number, Corners>;
}

function rgbaMat(cv: CV, img: RGBAImage): CV {
  const m = new cv.Mat(img.height, img.width, cv.CV_8UC4);
  m.data.set(img.data);
  return m;
}

function toImage(m: CV): RGBAImage {
  return { data: new Uint8ClampedArray(m.data), width: m.cols, height: m.rows };
}

/** Marker id to corners for the sheet's markers found in `img`; ids that are not on the sheet are ignored. */
export async function detectMarkers(img: RGBAImage): Promise<Map<number, Corners>> {
  const cv = await getCv();
  const rgba = rgbaMat(cv, img);
  const gray = new cv.Mat();
  const dict = cv.getPredefinedDictionary(cv.DICT_4X4_50);
  const params = new cv.aruco_DetectorParameters();
  const refine = new cv.aruco_RefineParameters(10, 3, true);   // cv2's defaults
  const detector = new cv.aruco_ArucoDetector(dict, params, refine);
  const corners = new cv.MatVector();
  const ids = new cv.Mat();
  const rejected = new cv.MatVector();
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    detector.detectMarkers(gray, corners, ids, rejected);
    const found = new Map<number, Corners>();
    for (let k = 0; k < ids.rows * ids.cols; k++) {
      const id = ids.data32S[k] as number;
      if (!MARKER_IDS.includes(id)) continue;
      const c = corners.get(k);
      const f = c.data32F as Float32Array;
      found.set(id, [0, 1, 2, 3].map((j) => [f[2 * j]!, f[2 * j + 1]!]) as Corners);
      c.delete();
    }
    return found;
  } finally {
    for (const o of [rgba, gray, dict, params, refine, detector, corners, ids, rejected]) o.delete();
  }
}

/** Sorted ids of the sheet's markers that are not in `found`. */
export function missingMarkers(found: Map<number, Corners>): number[] {
  return MARKER_IDS.filter((id) => !found.has(id));
}

/** Homography from photo pixels to sheet mm from all 16 marker corners (RANSAC), or null unless every marker was found. */
export async function homographyImg2Mm(found: Map<number, Corners>): Promise<Homography | null> {
  if (missingMarkers(found).length) return null;
  const cv = await getCv();
  const src = MARKER_IDS.flatMap((id) => found.get(id)!.flat());
  const dst = MARKER_IDS.flatMap((id) => SHEET.markers[id]!.flat());
  const s = cv.matFromArray(src.length / 2, 1, cv.CV_32FC2, src);
  const d = cv.matFromArray(dst.length / 2, 1, cv.CV_32FC2, dst);
  const H = cv.findHomography(s, d, cv.RANSAC);
  try {
    if (H.rows !== 3) return null;
    const h = H.data64F as Float64Array;
    return [[h[0]!, h[1]!, h[2]!], [h[3]!, h[4]!, h[5]!], [h[6]!, h[7]!, h[8]!]];
  } finally {
    for (const o of [s, d, H]) o.delete();
  }
}

/** Find the sheet in a photo; throws a SheetError unless all of its markers are visible. */
export async function detectSheet(img: RGBAImage): Promise<SheetDetection> {
  const corners = await detectMarkers(img);
  const missing = missingMarkers(corners);
  const H = missing.length ? null : await homographyImg2Mm(corners);
  if (!H) throw new SheetError(missing);
  return { H, corners };
}

/** Map a photo pixel to sheet mm with H. */
export function applyHomography(H: Homography, [x, y]: Point): Point {
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w, (H[1][0] * x + H[1][1] * y + H[1][2]) / w];
}

/** Warp `img` into the sheet-mm rectangle `box` at `pxPerMm`, as cv2.warpPerspective with that size would. */
function warpToBox(cv: CV, src: CV, H: Homography, box: Box, pxPerMm: number, flags: number, border: number[]): CV {
  const [x0, y0, x1, y1] = box;
  const S = pxPerMm;
  const A = [[S, 0, -x0 * S], [0, S, -y0 * S], [0, 0, 1]];
  const M = A.map((row) => [0, 1, 2].map((j) => row[0]! * H[0][j]! + row[1]! * H[1][j]! + row[2]! * H[2][j]!));
  const m = cv.matFromArray(3, 3, cv.CV_64F, M.flat());
  const out = new cv.Mat();
  const size = new cv.Size(Math.trunc((x1 - x0) * S), Math.trunc((y1 - y0) * S));
  try {
    cv.warpPerspective(src, out, m, size, flags, cv.BORDER_CONSTANT, new cv.Scalar(...border));
    return out;
  } catch (e) {
    out.delete();
    throw e;
  } finally {
    m.delete();
  }
}

export interface RectifiedRegion {
  /** The region at `pxPerMm`, markers whited out; pixels outside the photo are black. */
  canvas: RGBAImage;
  /** 255 where the pixel came from the photo, else 0 (one byte per pixel). */
  valid: Uint8Array;
}

/** Rectify any sheet-mm region of the tabletop plane (the homography holds for the whole plane, not just the
 * grid). Markers are whited out so they can't be mistaken for the tool. */
export async function rectRegion(img: RGBAImage, H: Homography, region: Box, pxPerMm = 8): Promise<RectifiedRegion> {
  const cv = await getCv();
  const mats: CV[] = [];
  try {
    const src = rgbaMat(cv, img);
    mats.push(src);
    const can = warpToBox(cv, src, H, region, pxPerMm, cv.INTER_LINEAR, [0, 0, 0, 255]);
    mats.push(can);
    const ones = new cv.Mat(img.height, img.width, cv.CV_8UC1, new cv.Scalar(255));
    mats.push(ones);
    const valid = warpToBox(cv, ones, H, region, pxPerMm, cv.INTER_NEAREST, [0]);
    mats.push(valid);
    const [x0, y0] = region;
    for (const cs of Object.values(SHEET.markers)) {
      const xs = cs.map((p) => p[0]);
      const ys = cs.map((p) => p[1]);
      const p0 = new cv.Point(Math.trunc((Math.min(...xs) - 4 - x0) * pxPerMm), Math.trunc((Math.min(...ys) - 4 - y0) * pxPerMm));
      const p1 = new cv.Point(Math.trunc((Math.max(...xs) + 4 - x0) * pxPerMm), Math.trunc((Math.max(...ys) + 4 - y0) * pxPerMm));
      cv.rectangle(can, p0, p1, new cv.Scalar(235, 235, 235, 255), -1);
    }
    return { canvas: toImage(can), valid: new Uint8Array(valid.data) };
  } finally {
    for (const o of mats) o.delete();
  }
}

export interface SheetView {
  /** The perspective-corrected sheet at `pxPerMm`; area outside the photo is dark grey. */
  image: RGBAImage;
  /** Its sheet-mm extent, rounded to 0.01 mm. */
  box: Box;
}

/** The whole perspective-corrected sheet the parts were shot on: the marker hull plus the quiet zone and a
 * margin, widened if any part (`outlinesSheetMm`, one ring each in sheet mm) hangs past it. */
export async function renderSheetView(img: RGBAImage, H: Homography, outlinesSheetMm: readonly (readonly Point[])[],
  pxPerMm = 4): Promise<SheetView> {
  const cv = await getCv();
  const mk = Object.values(SHEET.markers).flat();
  const m = 0.18 * SHEET.markerEdgeMm + 3;
  const pts = outlinesSheetMm.flat();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const box = [
    Math.min(Math.min(...mk.map((p) => p[0])) - m, Math.min(...xs) - 6),
    Math.min(Math.min(...mk.map((p) => p[1])) - m, Math.min(...ys) - 6),
    Math.max(Math.max(...mk.map((p) => p[0])) + m, Math.max(...xs) + 6),
    Math.max(Math.max(...mk.map((p) => p[1])) + m, Math.max(...ys) + 6),
  ] as Box;
  const src = rgbaMat(cv, img);
  try {
    const out = warpToBox(cv, src, H, box, pxPerMm, cv.INTER_LINEAR, [28, 28, 30, 255]);
    const image = toImage(out);
    out.delete();
    return { image, box: box.map((v) => Math.round(v * 100) / 100) as Box };
  } finally {
    src.delete();
  }
}
