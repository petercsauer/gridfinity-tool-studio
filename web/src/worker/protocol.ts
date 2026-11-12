// Typed request/response protocol between the UI thread and the pipeline worker.
// Every request carries a per-kind `version`; the client drops responses to requests
// that a newer request of the same kind has superseded.
import type { Ring } from '../geometry/pocket';
import type { Params } from '../params';

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
}

export interface BuildResult {
  /** Bin mesh in mm, Z up: xyz per vertex and three vertex indices per triangle. */
  positions: Float32Array;
  indices: Uint32Array;
  effectiveDepth: number;
  nx: number;
  ny: number;
}

export interface Requests {
  /** Where the static assets (presets/) live; sent once before anything else. */
  configure: { assetBase: string };
  listTools: Record<string, never>;
  outline: { params: Params };
  build: { params: Params };
  upload: { file: Blob; name: string };
}

export interface Results {
  configure: null;
  listTools: ToolInfo[];
  outline: OutlineResult;
  build: BuildResult;
  upload: ToolInfo;
}

export type Kind = keyof Requests;

export type Request<K extends Kind = Kind> = K extends Kind
  ? { id: number; kind: K; version: number } & Requests[K]
  : never;

export type ErrorCode = 'not-implemented' | 'unknown-tool' | 'too-large' | 'invalid' | 'internal';

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
