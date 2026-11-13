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
const MIN_PART_SHARE = 0.02;
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
  const x0 = Math.min(...first.map((f) => f.box[0]));
  const y0 = Math.min(...first.map((f) => f.box[1]));
  const x1 = Math.max(...first.map((f) => f.box[0] + f.box[2]));
  const y1 = Math.max(...first.map((f) => f.box[1] + f.box[3]));

  // pass 2: all the parts plus 15 mm, for precise edges; the parts found here are the ones traced
  const R2: Box = [R1[0] + x0 / PX - 15, R1[1] + y0 / PX - 15, R1[0] + x1 / PX + 15, R1[1] + y1 / PX + 15];
  const { canvas, valid } = await rectRegion(image, H, R2, PX);
  const mask = await env.segment(canvas);
  const found = findParts(cv, mask, [R2[0], R2[1]]);
  const parts: Part[] = [];
  const onSheet: Point[][] = [];
  try {
    if (!found.length) throw new PipelineError('no-tool', NO_TOOL);
    const row = (f: FoundPart) => Math.floor((R2[1] + f.centre[1] / PX) / ROW_MM);
    found.sort((p, q) => row(p) - row(q) || p.centre[0] - q.centre[0]);
    const fill = (f: FoundPart) => filledPart(cv, f.contour, mask.width, mask.height);
    found.forEach((f, i) => {
      const filled = fill(f);
      try {
        if (cutOff(cv, filled, valid)) throw new PipelineError('cut-off', found.length > 1 ? cutOffPart(i + 1) : CUT_OFF);
      } finally {
        filled.delete();
      }
    });
    for (const [i, f] of found.entries()) {
      // each part is traced from a mask holding only that part
      const filled = fill(f);
      const data = new Uint8Array(filled.data as Uint8Array);
      filled.delete();
      const up = await outlineFromMask({ width: mask.width, height: mask.height, data }, [R2[0], R2[1]] as Vec2, PX);
      const sym = symmetrize(manifold, up.outline);
      parts.push({
        id: `p${i + 1}`,
        outline: up.outline,
        crop: up.crop,
        up2sheet: up.up2sheet,
        symmetry: { outline: sym.outline, score: sym.score, axisDeg: sym.axisDeg, offset: sym.offset, centre: sym.centre },
      });
      const [[a, b, c], [d, e, g]] = up.up2sheet;
      onSheet.push(up.outline.map(([qx, qy]): Point => [a * qx + b * qy + c, d * qx + e * qy + g]));
    }
  } finally {
    for (const f of found) f.contour.delete();
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
