// Loads the Python parity fixtures in tests/fixtures/ (see tests/fixtures/README.md).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Ring } from '../geometry/pocket';

export const TOOLS = ['needlenose', 'combopliers', 'flushcutter', 'stripper'] as const;

export interface PresetFixture {
  tool: string;
  outline_mm: Ring;
  crop_mm: [number, number];
  up2sheet: [[number, number, number], [number, number, number]];
  symmetric_outline_mm: Ring;
  symmetry_score: number;
  params: {
    clearance: number; rot: number; slotOn: boolean; slotR: number; slotOver: number;
    slotFrac: number; u: number; depth: number; fillet: number; bfillet: number; sym: boolean;
  };
  pocket_mm: Ring;
  footprint: [number, number];
  bin: { bbox: [[number, number, number], [number, number, number]]; volume_mm3: number; effective_depth: number };
}

const ROOT = new URL('../../../', import.meta.url);

export function presetFixture(tool: string): PresetFixture {
  const path = fileURLToPath(new URL(`tests/fixtures/presets/${tool}.json`, ROOT));
  return JSON.parse(readFileSync(path, 'utf-8')) as PresetFixture;
}

/** Distance from point p to segment ab. */
function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Largest distance from a vertex of A to the closed ring B. */
function directed(A: Ring, B: Ring): number {
  let worst = 0;
  for (const p of A) {
    let best = Infinity;
    for (let i = 0; i < B.length; i++) best = Math.min(best, segDist(p, B[i]!, B[(i + 1) % B.length]!));
    worst = Math.max(worst, best);
  }
  return worst;
}

/** Symmetric Hausdorff distance between two closed rings (vertices to edges). */
export function hausdorff(A: Ring, B: Ring): number {
  return Math.max(directed(A, B), directed(B, A));
}
