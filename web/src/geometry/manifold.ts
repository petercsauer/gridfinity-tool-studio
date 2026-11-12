import Module, { type ManifoldToplevel } from 'manifold-3d';

let ready: Promise<ManifoldToplevel> | null = null;

/** The initialised manifold-3d module (loaded once). In the browser pass the URL of
 * `manifold.wasm`; in Node the package finds it next to its own entry. */
export function initManifold(wasmUrl?: string): Promise<ManifoldToplevel> {
  ready ??= Module(wasmUrl ? { locateFile: () => wasmUrl } : undefined).then((m) => {
    m.setup();
    return m;
  });
  return ready;
}
