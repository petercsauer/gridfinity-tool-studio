// Tracing an uploaded calibration-sheet photo. Mirrors process_photo in src/gts/trace.py: find the sheet,
// pass 1 segments the whole page plus a 40 mm margin to find the tool, pass 2 segments a tight crop around it
// for precise edges, then the upright outline, its symmetric version and the sheet view.
import type { Vec2 } from '../../geometry/pocket';
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
/** Fewest foreground pixels that count as a tool: 8 mm x 8 mm. */
const MIN_TOOL_PX = (8 * PX) ** 2;
/** JPEG quality of the sheet view (Python uses 88). */
const JPEG_QUALITY = 0.88;

/** What the upload pipeline runs on besides opencv.js; tests swap in their own. */
export interface UploadEnv {
  /** Background removal: an RGBA image to a 0-255 mask of the same size. */
  segment(img: RGBAImage): Promise<Mask>;
  encodeJpeg(img: RGBAImage): Promise<Blob>;
  /** Told when the pipeline moves to finding the sheet and then to tracing the tool. */
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

interface Tool {
  /** Pixels above 128 in the whole mask. */
  foreground: number;
  /** Bounding box [x, y, w, h] of the largest contour. */
  box: [number, number, number, number];
  /** The largest contour filled with 255 (the caller deletes it), when asked for. */
  filled: CV | null;
}

/** The largest external contour of a mask (thresholded at > 128): its bounding box and, optionally, filled. */
function largestTool(cv: CV, mask: Mask, fill: boolean): Tool {
  const src = cv.matFromArray(mask.height, mask.width, cv.CV_8UC1, mask.data);
  const bin = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.threshold(src, bin, 128, 1, cv.THRESH_BINARY);
    const foreground = cv.countNonZero(bin);
    cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    let best = -1;
    let bestArea = -Infinity;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      if (a > bestArea) {
        best = i;
        bestArea = a;
      }
      c.delete();
    }
    if (best < 0) return { foreground, box: [0, 0, 0, 0], filled: null };
    const c = contours.get(best);
    const r = cv.boundingRect(c);
    c.delete();
    let filled: CV = null;
    if (fill) {
      filled = cv.Mat.zeros(mask.height, mask.width, cv.CV_8UC1);
      cv.drawContours(filled, contours, best, new cv.Scalar(255), -1);
    }
    return { foreground, box: [r.x, r.y, r.width, r.height], filled };
  } finally {
    for (const m of [src, bin, contours, hierarchy]) m.delete();
  }
}

/** Whether the filled tool, grown by 3 px, reaches pixels from outside the photo or touches the canvas border. */
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

/** Trace a calibration-sheet photo (RGBA, long side at most MAX_SIDE) into a new tool. */
export async function upload(image: RGBAImage, name: string, { manifold }: Deps, env: UploadEnv): Promise<UploadResult> {
  checkImage(image);
  env.stage?.('sheet');
  const H = await findSheet(image);
  env.stage?.('trace');
  const cv = await getCv();
  const [pw, ph] = SHEET.pageMm;

  // pass 1: the whole page plus 40 mm, to find the tool wherever it is
  const R1: Box = [-40, -40, pw + 40, ph + 40];
  const first = largestTool(cv, await env.segment((await rectRegion(image, H, R1, PX)).canvas), false);
  if (first.foreground < MIN_TOOL_PX) throw new PipelineError('no-tool', NO_TOOL);
  const [x, y, w, h] = first.box;
  const bx0 = R1[0] + x / PX;
  const by0 = R1[1] + y / PX;

  // pass 2: the tool plus 15 mm, for precise edges
  const R2: Box = [bx0 - 15, by0 - 15, bx0 + w / PX + 15, by0 + h / PX + 15];
  const { canvas, valid } = await rectRegion(image, H, R2, PX);
  const mask = await env.segment(canvas);
  const second = largestTool(cv, mask, true);
  try {
    if (second.foreground < MIN_TOOL_PX || !second.filled) throw new PipelineError('no-tool', NO_TOOL);
    if (cutOff(cv, second.filled, valid)) throw new PipelineError('cut-off', CUT_OFF);
  } finally {
    second.filled?.delete();
  }

  const up = await outlineFromMask(mask, [R2[0], R2[1]] as Vec2, PX);
  const sym = symmetrize(manifold, up.outline);
  const [[a, b, c], [d, e, f]] = up.up2sheet;
  const onSheet = up.outline.map(([qx, qy]): Point => [a * qx + b * qy + c, d * qx + e * qy + f]);
  const view = await renderSheetView(image, H, onSheet, SHEET_PX);
  return {
    id: `up-${crypto.randomUUID().slice(0, 8)}`,
    label: label(name),
    sym: false,
    outline: up.outline,
    crop: up.crop,
    up2sheet: up.up2sheet,
    symmetry: { outline: sym.outline, score: sym.score, axisDeg: sym.axisDeg, offset: sym.offset },
    sheetViewJpeg: await env.encodeJpeg(view.image),
    sheetBox: view.box,
  };
}
