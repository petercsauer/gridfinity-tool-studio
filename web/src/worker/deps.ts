import type { ManifoldToplevel } from 'manifold-3d';
import type { PresetSource } from './presets';

/** What the worker's request handlers run against. */
export interface Deps {
  manifold: ManifoldToplevel;
  presets: PresetSource;
}
