// Typed request/response protocol between the UI thread and the pipeline worker.
// Every request carries a per-kind `version`; the client drops responses to requests
// that a newer request of the same kind has superseded.
import type { Ring, Vec2 } from '../geometry/pocket';
import type { Params } from '../params';
import type { Affine } from '../vision/outline';
import type { Box, RGBAImage } from '../vision/sheet';

export interface ToolInfo {
  id: string;
  label: string;
  /** Whether "Symmetric tool" is on by default for this tool. */
  sym: boolean;
}

export interface OutlineResult {
  /** Tool and pocket rings in the rotated outline frame (mm). */
  tool: Ring;
  pocket: Ring;
  /** Tool and pocket (unrotated) in sheet mm, for drawing on the sheet image. */
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
}

export interface BuildResult {
  /** Bin mesh in mm, Z up: xyz per vertex and three vertex indices per triangle. */
  positions: Float32Array;
  indices: Uint32Array;
  effectiveDepth: number;
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
  outline: { params: Params };
  build: { params: Params };
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
 * the tool is outside the photo. */
export type ErrorCode = 'not-implemented' | 'unknown-tool' | 'too-large' | 'invalid' | 'no-sheet' | 'no-tool' | 'cut-off'
  | 'internal';

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
