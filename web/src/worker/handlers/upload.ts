// Tracing an uploaded calibration-sheet photo into a kit. Mirrors process_photo in src/gts/trace.py for each
// part: find the sheet, pass 1 segments the whole page plus a 40 mm margin to find the parts, pass 2 segments
// one tight crop around all of them for precise edges, then each part's upright outline and symmetric
// version, and the sheet view.
import type { Vec2 } from '../../geometry/pocket';
import type { Part } from '../../kit';
import { MAX_SIDE } from '../../vision/decode';
import { getSession, type Progress } from '../../vision/model';
import { getCv, type CV } from '../../vision/opencv';
import { outlineFromMask, type Mask } from '../../vision/outline';
import { segment } from '../../vision/segment';
import { detectSheet, rectRegion, renderSheetView, SHEET, SheetError, type Box, type Homography, type Point, type RGBAImage } from '../../vision/sheet';
import { straighten } from '../../vision/straighten';
import { symmetrize } from '../../vision/symmetry';
import type { Deps } from '../deps';
import { isOutOfMemory, memoryError, PipelineError, type UploadResult } from '../protocol';

/** Working scale of the rectified canvases (px per mm), as in Python. */
const PX = 8;
/** Scale of the sheet view (px per mm). */
const SHEET_PX = 4;
/** Fewest foreground pixels that count as a part: 8 mm x 8 mm. */
const MIN_TOOL_PX = (8 * PX) ** 2;
/** Blobs smaller than this share of the largest are specks or shadows, not parts. */
const MIN_PART_SHARE = 0.01;
/** Most parts one photo can hold. */
export const MAX_PARTS = 12;
/** The paper in sheet mm, Letter or A4 (the markers sit the same on both): a part's centre lies on it. */
const PAPER: Box = [0, 0, 215.9, 297];
/** Height (mm) of the rows parts are numbered in: rows top to bottom, then left to right within a row. */
const ROW_MM = 20;
/** JPEG quality of the sheet view (Python uses 88). */
const JPEG_QUALITY = 0.88;

/** What the upload pipeline runs on besides opencv.js; tests swap in their own. */
export interface UploadEnv {
  /** Background removal: an RGBA image to a 0-255 mask of the same size. */
  segment(img: RGBAImage): Promise<Mask>;
  encodeJpeg(img: RGBAImage): Promise<Blob>;
  /** Told when the pipeline moves to finding the sheet and then to tracing the parts. */
  stage?(stage: 'sheet' | 'trace'): void;
}

/** The worker's environment: IS-Net from the Cache API (downloaded on first use, reporting progress) and
 * OffscreenCanvas for the JPEG. */
export function workerUploadEnv(onProgress?: Progress, stage?: UploadEnv['stage']): UploadEnv {
  return {
    stage,
    // model failures (download, session, inference) get their own code; running out of memory gets 'memory'
    segment: async (img) => {
      try {
        return await segment(await getSession(onProgress), img);
      } catch (e) {
        if (isOutOfMemory(e)) throw memoryError();
        if (e instanceof PipelineError) throw e;
        throw new PipelineError('model', `The background-removal model couldn't run: ${String(e)}`);
      }
    },
    async encodeJpeg({ data, width, height }) {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new PipelineError('internal', 'This browser cannot draw images off screen.');
      ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
      return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    },
  };
}

const NO_TOOL = 'Calibration sheet found, but no tool was detected on it.';
const CUT_OFF = 'Part of the tool is outside the photo. Step back so the whole tool and all four markers are in frame.';
const cutOffPart = (n: number) => `Part ${n} runs off the photo. Step back so every part and all four markers are in frame.`;
const tooMany = (n: number) =>
  `There are ${n} parts on the sheet; a kit can have at most ${MAX_PARTS}. Photograph fewer parts at a time.`;

interface FoundPart {
  /** Its external contour (CV_32SC2; the caller deletes it). */
  contour: CV;
  /** Bounding box [x, y, w, h] and area centroid of the contour (mask px). */
  box: [number, number, number, number];
  centre: [number, number];
}

/** The external contours of a mask (thresholded at > 128) whose pixel (0, 0) sits at `originMm` on the sheet
 * that count as parts: centred on the paper (so clutter on the table around it isn't a part), at least
 * MIN_TOOL_PX and MIN_PART_SHARE of the largest such, largest first. More than MAX_PARTS is a
 * `too-many-parts` error. */
function findParts(cv: CV, mask: Mask, originMm: Vec2): FoundPart[] {
  const src = cv.matFromArray(mask.height, mask.width, cv.CV_8UC1, mask.data);
  const bin = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.threshold(src, bin, 128, 1, cv.THRESH_BINARY);
    cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    const blobs: { i: number; area: number; centre: [number, number] }[] = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      const mo = cv.moments(c);
      c.delete();
      if (!(mo.m00 > 0)) continue;
      const centre: [number, number] = [mo.m10 / mo.m00, mo.m01 / mo.m00];
      const [sx, sy] = [originMm[0] + centre[0] / PX, originMm[1] + centre[1] / PX];
      if (sx >= PAPER[0] && sx <= PAPER[2] && sy >= PAPER[1] && sy <= PAPER[3]) blobs.push({ i, area, centre });
    }
    const min = Math.max(MIN_TOOL_PX, MIN_PART_SHARE * Math.max(0, ...blobs.map((b) => b.area)));
    const keep = blobs.filter((b) => b.area >= min).sort((p, q) => q.area - p.area);
    if (keep.length > MAX_PARTS) throw new PipelineError('too-many-parts', tooMany(keep.length));
    return keep.map(({ i, centre }): FoundPart => {
      const c = contours.get(i);
      const r = cv.boundingRect(c);
      return { contour: c, box: [r.x, r.y, r.width, r.height], centre };
    });
  } finally {
    for (const m of [src, bin, contours, hierarchy]) m.delete();
  }
}

/** A `w` x `h` mask with only `contour` filled with 255 (the caller deletes it). */
function filledPart(cv: CV, contour: CV, w: number, h: number): CV {
  const one = new cv.MatVector();
  const filled = cv.Mat.zeros(h, w, cv.CV_8UC1);
  try {
    one.push_back(contour);
    cv.drawContours(filled, one, 0, new cv.Scalar(255), -1);
    return filled;
  } catch (e) {
    filled.delete();
    throw e;
  } finally {
    one.delete();
  }
}

/** Whether the filled part, grown by 3 px, reaches pixels from outside the photo or touches the canvas border. */
function cutOff(cv: CV, tool: CV, valid: Uint8Array): boolean {
  const kernel = cv.Mat.ones(7, 7, cv.CV_8U);
  const grown = new cv.Mat();
  try {
    cv.dilate(tool, grown, kernel);
    const g = grown.data as Uint8Array;
    for (let i = 0; i < g.length; i++) if (g[i] && !valid[i]) return true;
    const t = tool.data as Uint8Array;
    const { rows: h, cols: w } = tool;
    for (let x = 0; x < w; x++) if (t[x] || t[(h - 1) * w + x]) return true;
    for (let y = 0; y < h; y++) if (t[y * w] || t[y * w + w - 1]) return true;
    return false;
  } finally {
    kernel.delete();
    grown.delete();
  }
}

function checkImage(img: RGBAImage): void {
  const { width: w, height: h, data } = img;
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0) || data?.length !== w * h * 4) {
    throw new PipelineError('invalid', 'This file could not be read as an image. Use a JPEG, PNG or HEIC photo.');
  }
  if (Math.max(w, h) > MAX_SIDE) {
    throw new PipelineError('too-large', `The photo is too large (${w} x ${h}); the longest side can be at most ${MAX_SIDE} px.`);
  }
}

async function findSheet(img: RGBAImage): Promise<Homography> {
  try {
    return (await detectSheet(img)).H;
  } catch (e) {
    if (e instanceof SheetError) throw new PipelineError('no-sheet', e.message);
    throw e;
  }
}

/** A part found in a segmented region, with what tracing it needs. */
interface Traced extends FoundPart {
  /** The region (sheet mm) the mask covers, the mask and which of its pixels came from the photo. */
  region: Box;
  mask: Mask;
  valid: Uint8Array;
  /** Area centroid in sheet mm, and bounding-box area in mask px (to pick the biggest). */
  centreMm: Vec2;
  area: number;
}

/** Segment `region` of the sheet and find the parts in it (the caller deletes their contours). */
async function traceRegion(cv: CV, image: RGBAImage, H: Homography, region: Box, env: UploadEnv): Promise<Traced[]> {
  const { canvas, valid } = await rectRegion(image, H, region, PX);
  const mask = await env.segment(canvas);
  return findParts(cv, mask, [region[0], region[1]]).map((f) => ({
    ...f, region, mask, valid,
    centreMm: [region[0] + f.centre[0] / PX, region[1] + f.centre[1] / PX],
    area: f.box[2] * f.box[3],
  }));
}

/** A traced part's bounding box in sheet mm. */
const boxMm = ({ region: [rx, ry], box: [x, y, w, h] }: Traced): Box => [rx + x / PX, ry + y / PX, rx + (x + w) / PX, ry + (y + h) / PX];

/** Whether two sheet-mm boxes overlap. */
const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** Whether `p` lies in `box` grown by `pad` mm. */
const inBox = ([x, y]: Vec2, [x0, y0, x1, y1]: Box, pad: number) => x >= x0 - pad && x <= x1 + pad && y >= y0 - pad && y <= y1 + pad;

const label = (name: string) => name.trim().slice(0, 40) || 'Upload';

/** Trace a calibration-sheet photo (RGBA, long side at most MAX_SIDE) into a new kit with one part per object
 * on the sheet. */
export async function upload(image: RGBAImage, name: string, { manifold }: Deps, env: UploadEnv): Promise<UploadResult> {
  checkImage(image);
  env.stage?.('sheet');
  const H = await findSheet(image);
  env.stage?.('trace');
  const cv = await getCv();
  const [pw, ph] = SHEET.pageMm;

  // pass 1: the whole page plus 40 mm, to find the parts wherever they are
  const R1: Box = [-40, -40, pw + 40, ph + 40];
  const first = findParts(cv, await env.segment((await rectRegion(image, H, R1, PX)).canvas), [R1[0], R1[1]]);
  for (const f of first) f.contour.delete();
  if (!first.length) throw new PipelineError('no-tool', NO_TOOL);
  /** Pass-1 parts' boxes in sheet mm. */
  const seen = first.map(({ box: [x, y, w, h] }): Box => [R1[0] + x / PX, R1[1] + y / PX, R1[0] + (x + w) / PX, R1[1] + (y + h) / PX]);

  // pass 2: all the parts plus 15 mm, for precise edges
  const R2: Box = [
    Math.min(...seen.map((b) => b[0])) - 15, Math.min(...seen.map((b) => b[1])) - 15,
    Math.max(...seen.map((b) => b[2])) + 15, Math.max(...seen.map((b) => b[3])) + 15,
  ];
  const traced: Traced[] = [];
  const parts: Part[] = [];
  const onSheet: Point[][] = [];
  try {
    traced.push(...await traceRegion(cv, image, H, R2, env));
    // the model can drop a small part from a crop holding a larger one (an antenna beside its analyser): each
    // pass-1 part no pass-2 part lies in is segmented again in its own crop
    for (const b of seen) {
      // already traced: a pass-2 part lies in it, or it is a piece of one (its centre is in a part's box)
      const mid: Vec2 = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
      if (traced.some((t) => inBox(t.centreMm, b, 2) || inBox(mid, boxMm(t), 0))) continue;
      // pass 1 may have seen only some of the part, so the crop grows around what is found until the part
      // stays clear of its edges
      let region: Box = [b[0] - 15, b[1] - 15, b[2] + 15, b[3] + 15];
      let keep: Traced | null = null;
      for (let tries = 0; tries < 3; tries++) {
        keep?.contour.delete();
        const own = await traceRegion(cv, image, H, region, env);
        const mine = own.filter((t) => inBox(t.centreMm, b, 2) || overlaps(boxMm(t), b));
        keep = mine.length ? mine.reduce((p, q) => (q.area > p.area ? q : p)) : null;
        for (const t of own) if (t !== keep) t.contour.delete();
        if (!keep) break;
        const k = boxMm(keep);
        if (k[0] - region[0] > 3 && k[1] - region[1] > 3 && region[2] - k[2] > 3 && region[3] - k[3] > 3) break;
        region = [k[0] - 15, k[1] - 15, k[2] + 15, k[3] + 15];
      }
      if (keep) traced.push(keep);
    }
    if (!traced.length) throw new PipelineError('no-tool', NO_TOOL);
    if (traced.length > MAX_PARTS) throw new PipelineError('too-many-parts', tooMany(traced.length));
    const row = (t: Traced) => Math.floor(t.centreMm[1] / ROW_MM);
    traced.sort((p, q) => row(p) - row(q) || p.centreMm[0] - q.centreMm[0]);
    const fill = (t: Traced) => filledPart(cv, t.contour, t.mask.width, t.mask.height);
    traced.forEach((t, i) => {
      const filled = fill(t);
      try {
        if (cutOff(cv, filled, t.valid)) throw new PipelineError('cut-off', traced.length > 1 ? cutOffPart(i + 1) : CUT_OFF);
      } finally {
        filled.delete();
      }
    });
    for (const [i, t] of traced.entries()) {
      // each part is traced from a mask holding only that part
      const filled = fill(t);
      const data = new Uint8Array(filled.data as Uint8Array);
      filled.delete();
      const up = await outlineFromMask({ width: t.mask.width, height: t.mask.height, data }, [t.region[0], t.region[1]] as Vec2, PX);
      // edges the mask wobbles along but that are straight (a box's sides) become straight lines
      const outline = straighten(up.outline);
      const sym = symmetrize(manifold, outline);
      parts.push({
        id: `p${i + 1}`,
        outline,
        crop: up.crop,
        up2sheet: up.up2sheet,
        symmetry: { outline: sym.outline, score: sym.score, axisDeg: sym.axisDeg, offset: sym.offset, centre: sym.centre },
      });
      const [[a, b, c], [d, e, g]] = up.up2sheet;
      onSheet.push(outline.map(([qx, qy]): Point => [a * qx + b * qy + c, d * qx + e * qy + g]));
    }
  } finally {
    for (const t of traced) t.contour.delete();
  }

  const view = await renderSheetView(image, H, onSheet, SHEET_PX);
  return {
    id: `up-${crypto.randomUUID().slice(0, 8)}`,
    label: label(name),
    sym: false,
    parts,
    sheetViewJpeg: await env.encodeJpeg(view.image),
    sheetBox: view.box,
  };
}
