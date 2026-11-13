// Typed request/response protocol between the UI thread and the pipeline worker.
// Every request carries a per-kind `version`; the client drops responses to requests
// that a newer request of the same kind has superseded.
import type { LayoutWarning } from '../geometry/kit-checks';
import type { Box2, Ring, Vec2 } from '../geometry/pocket';
import type { Layout } from '../kit';
import type { Params } from '../params';
import type { Affine } from '../vision/outline';
import type { Box, RGBAImage } from '../vision/sheet';

export interface ToolInfo {
  id: string;
  label: string;
  /** Whether "Symmetric tool" is on by default for this tool. */
  sym: boolean;
}

/** One part of the kit as traced and placed. */
export interface PartTrace {
  id: string;
  /** Tool and pocket rings in the part's own upright frame (mm); the placement turns and moves them. */
  tool: Ring;
  pocket: Ring;
  /** Tool and pocket where the part lay on the sheet (sheet mm). */
  sheetTool: Ring;
  sheetPocket: Ring;
  /** With the part's "Symmetric" on: its mirror axis as a segment spanning it, in sheet mm. */
  sheetAxis?: [Vec2, Vec2];
  /** How symmetric the part is (mirror IoU, 1 = perfectly) and the angle of the axis it snaps by (degrees
   * from the part frame's y axis). */
  symmetryScore: number;
  axisDeg: number;
  measure: Measurements;
}

export interface OutlineResult {
  /** Every part of the kit (hidden ones included), in layout order. */
  parts: PartTrace[];
  /** The layout the result was made for: the one requested, clamped, or the kit's initial layout. */
  layout: Layout;
  /** The first visible part's tool and pocket, placed in the bin (mm). */
  tool: Ring;
  pocket: Ring;
  /** The first visible part's tool and pocket in sheet mm, for drawing on the sheet image. */
  sheetTool: Ring;
  sheetPocket: Ring;
  /** With "Symmetric tool" on: the mirror axis as a segment spanning the tool, in sheet mm. */
  sheetAxis?: [Vec2, Vec2];
  /** Sheet-mm extent [x0, y0, x1, y1] of the sheet image. */
  sheetBox: [number, number, number, number];
  /** URL of the sheet image, relative to the app's base URL. */
  sheetImage: string;
  /** Footprint in grid cells and pocket size in mm. */
  nx: number;
  ny: number;
  w: number;
  h: number;
  /** Deepest pocket for the requested height, and the depth that will be cut. */
  maxDepth: number;
  effectiveDepth: number;
  /** How symmetric the tool is (mirror IoU, 1 = perfectly). */
  symmetryScore: number;
  /** Pocket and tool sizes along the tool's own upright axes, for the dimension labels on the trace. */
  measure?: Measurements;
  /** Overlapping pockets, too-thin walls between pockets and pockets outside a locked bin (see checkLayout). */
  warnings?: LayoutWarning[];
}

export type { LayoutWarning };

/** The unrotated pocket and tool measured in the upright outline frame (x across the tool, y along it). */
export interface Measurements {
  /** Bounding boxes of the pocket and the tool in that frame (mm). */
  pocket: Box2;
  tool: Box2;
  /** 2x3 affine [A | b] from that frame to sheet mm, to draw the boxes' sides on the sheet. */
  up2sheet: Affine;
  /** Pocket and tool width (x) and length (y) in mm, to 0.1 mm. */
  pocketSize: [number, number];
  toolSize: [number, number];
  /** Clearance on each side: from the tool's box to the pocket's box (mm, to 0.1 mm). Differs per side when
   * the finger slot sticks out. */
  gaps: { xmin: number; xmax: number; ymin: number; ymax: number };
}

export interface BuildResult {
  /** Bin mesh in mm, Z up: xyz per vertex and three vertex indices per triangle. */
  positions: Float32Array;
  indices: Uint32Array;
  /** The deepest pocket cut, and each layout placement's (0 for hidden ones), in layout order. */
  effectiveDepth: number;
  effectiveDepths?: number[];
  nx: number;
  ny: number;
}

export interface UploadResult extends ToolInfo {
  /** Upright, centred tool outline (mm), 720 points, last repeats the first. */
  outline: Ring;
  /** Size [w, h] of the upright crop the outline is centred in (mm). */
  crop: [number, number];
  /** 2x3 affine [A | b] from outline mm to sheet mm: sheet = A q + b. */
  up2sheet: Affine;
  /** The symmetric version of the outline and how symmetric the tool is (mirror IoU, 1 = perfectly). */
  symmetry: { outline: Ring; score: number; axisDeg: number; offset: number };
  /** JPEG of the perspective-corrected sheet the tool was shot on, and its sheet-mm extent [x0, y0, x1, y1]. */
  sheetViewJpeg: Blob;
  sheetBox: Box;
}

/** An uploaded tool as the worker needs it: the upload result with the sheet view as a URL (an object URL the
 * UI thread created for `sheetViewJpeg`) instead of the image itself. */
export type StoredTool = Omit<UploadResult, 'sheetViewJpeg'> & { sheetImage: string };

/** Upload progress: finding the sheet, downloading the model (bytes), then tracing the tool. */
export type Progress = { stage: 'sheet' } | { stage: 'model'; loaded: number; total: number } | { stage: 'trace' };

/** Sent by the worker while a request runs (before its response), e.g. during the model download. */
export interface ProgressMessage {
  id: number;
  progress: Progress;
}

export interface Requests {
  /** Where the static assets (presets/) live; sent once before anything else. */
  configure: { assetBase: string };
  listTools: Record<string, never>;
  /** Without a layout the tool's initial layout is used (see kit.ts initialLayout). */
  outline: { params: Params; layout?: Layout };
  build: { params: Params; layout?: Layout };
  /** A photo decoded on the UI thread (decodePhoto); send its pixel buffer as a transferable. */
  upload: { image: RGBAImage; name: string };
  /** Make an uploaded tool (restored from storage or just uploaded) available to outline and build. */
  addTool: { tool: StoredTool };
  removeTool: { id: string };
}

export interface Results {
  configure: null;
  listTools: ToolInfo[];
  outline: OutlineResult;
  build: BuildResult;
  upload: UploadResult;
  addTool: null;
  removeTool: null;
}

export type Kind = keyof Requests;

export type Request<K extends Kind = Kind> = K extends Kind
  ? { id: number; kind: K; version: number } & Requests[K]
  : never;

/** `no-sheet`: the calibration markers weren't all found; `no-tool`: nothing on the sheet; `cut-off`: part of
 * the tool is outside the photo; `model`: the background-removal model couldn't be downloaded or run;
 * `memory`: the browser ran out of memory. */
export type ErrorCode = 'not-implemented' | 'unknown-tool' | 'too-large' | 'invalid' | 'no-sheet' | 'no-tool' | 'cut-off'
  | 'model' | 'memory' | 'internal';

/** Whether an error looks like the browser running out of memory: a failed ArrayBuffer or WebAssembly memory
 * allocation, an Emscripten OOM abort, or onnxruntime failing to allocate a tensor. Checks the message too,
 * since errors from the worker arrive as text. */
export function isOutOfMemory(e: unknown): boolean {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return /out of memory|\bOOM\b|allocation failed|(failed|unable|could not|cannot|can't) (to )?allocate|cannot enlarge memory|memory\.grow|maximum memory size/i
    .test(text);
}

/** A PipelineError for an out-of-memory error. */
export function memoryError(): PipelineError {
  return new PipelineError('memory', 'This device ran out of memory. Close other tabs or apps and try again, or use a smaller photo.');
}

export type Response<K extends Kind = Kind> = K extends Kind
  ? | { id: number; kind: K; version: number; ok: true; result: Results[K] }
    | { id: number; kind: K; version: number; ok: false; code: ErrorCode; error: string }
  : never;

/** An error the pipeline reports to the user; `message` is shown as is. */
export class PipelineError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'PipelineError';
  }
}
