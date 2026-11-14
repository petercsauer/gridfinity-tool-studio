// The demo tools the app ships (web/public/presets, written by scripts/build_presets.py): each one is
// listed, traces, has its sheet image and mirror axis, and builds a bin inside the size limit.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { initManifold } from '../geometry/manifold';
import { DEFAULTS, MAX_CELLS } from '../params';
import { build } from './handlers/build';
import { outline } from './handlers/outline';
import type { PresetData, PresetSource } from './presets';
import { PipelineError } from './protocol';

const dir = new URL('../../public/presets/', import.meta.url);
const read = <T>(file: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(file, dir)), 'utf-8')) as T;
const index = read<{ presets: { id: string; label: string; sym: boolean }[] }>('index.json').presets;
const shipped: PresetSource = {
  list: async () => index,
  get: async (id) => {
    if (!index.some((t) => t.id === id)) throw new PipelineError('unknown-tool', id);
    return read<PresetData>(`${id}.json`);
  },
  url: (file) => `presets/${file}`,
};

let m: ManifoldToplevel;
beforeAll(async () => {
  m = await initManifold();
});

it('ships the two demo tools, the first one selected by default', () => {
  expect(index.map((t) => t.id)).toEqual(['groovejoint', 'studfinder']);
  expect(DEFAULTS.tool).toBe(index[0]!.id);
});

describe.each(index)('shipped preset $id', ({ id, sym }) => {
  it('has its sheet image and a mirror axis', async () => {
    const p = await shipped.get(id);
    expect(existsSync(fileURLToPath(new URL(p.sheet_image, dir)))).toBe(true);
    expect(p.symmetry_axis).toBeDefined();
    expect(p.sym).toBe(sym);
  });

  it('traces and builds a bin within the size limit', async () => {
    const params = { ...DEFAULTS, tool: id, sym };
    const o = await outline(params, { manifold: m, presets: shipped });
    expect(o.nx).toBeLessThanOrEqual(MAX_CELLS);
    expect(o.ny).toBeLessThanOrEqual(MAX_CELLS);
    expect(!!o.parts[0]!.sheetAxis).toBe(sym);
    const b = await build(params, { manifold: m, presets: shipped });
    expect([b.nx, b.ny]).toEqual([o.nx, o.ny]);
    expect(b.indices.length).toBeGreaterThan(1000);
  });
});
