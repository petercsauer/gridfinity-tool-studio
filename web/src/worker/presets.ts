// Built-in presets: static JSON written by scripts/build_presets.py into public/presets/.
import type { Ring } from '../geometry/pocket';
import { PipelineError, type ToolInfo } from './protocol';

export interface PresetData {
  id: string;
  label: string;
  sym: boolean;
  /** Size [w, h] of the upright crop the outline is centred in. */
  crop_mm: [number, number];
  /** Upright, centred tool outline and its symmetric version (mm). */
  outline_mm: Ring;
  symmetric_outline_mm: Ring;
  symmetry_score: number;
  /** 2x3 affine [A | b] from outline mm to sheet mm: sheet = A q + b. */
  up2sheet: [[number, number, number], [number, number, number]];
  /** Sheet-mm extent [x0, y0, x1, y1] of the sheet image. */
  sheet_box_mm: [number, number, number, number];
  /** File name of the sheet image, next to the JSON. */
  sheet_image: string;
}

export interface PresetSource {
  list(): Promise<ToolInfo[]>;
  get(id: string): Promise<PresetData>;
  /** URL of a file in the presets folder, relative to the app's base URL. */
  url(file: string): string;
}

/** Presets fetched from `<assetBase>presets/`, each file once. */
export function fetchPresets(assetBase: string): PresetSource {
  const dir = 'presets/';
  const load = async <T>(file: string): Promise<T> => {
    const res = await fetch(new URL(dir + file, assetBase));
    if (!res.ok) throw new PipelineError('internal', `Couldn't load ${dir}${file} (HTTP ${res.status}).`);
    return (await res.json()) as T;
  };
  let index: Promise<ToolInfo[]> | null = null;
  const cache = new Map<string, Promise<PresetData>>();
  const list = () => (index ??= load<{ presets: ToolInfo[] }>('index.json').then((j) => j.presets));
  return {
    list,
    async get(id) {
      if (!(await list()).some((t) => t.id === id)) throw new PipelineError('unknown-tool', `There is no tool called "${id}".`);
      let p = cache.get(id);
      if (!p) cache.set(id, (p = load<PresetData>(`${id}.json`)));
      return p;
    },
    url: (file) => dir + file,
  };
}
