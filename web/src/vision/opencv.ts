// Shared lazy loader for opencv.js (@techstark/opencv-js). Works in the Web Worker and in Vitest (node).
// The ArUco detector in this build is exposed as cv.aruco_ArucoDetector; dictionaries via cv.getPredefinedDictionary.
// Every cv.Mat / cv.MatVector you create must be .delete()d.

// opencv.js ships no usable types for its emscripten API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any;

let loading: Promise<{ cv: CV }> | null = null;

const isNode = typeof process !== 'undefined' && !!process.versions?.node && typeof (globalThis as { document?: unknown }).document === 'undefined'
  && typeof (globalThis as { importScripts?: unknown }).importScripts === 'undefined';

async function loadModule(): Promise<CV> {
  if (isNode) {
    // Vitest's ESM interop awaits CommonJS exports, and opencv.js's export has a `then`; plain require avoids that.
    const spec = 'node:module';
    const { createRequire } = await import(/* @vite-ignore */ spec);
    return createRequire(import.meta.url)('@techstark/opencv-js');
  }
  const { box } = await import('./cv-entry');   // bundled by Vite into the worker chunk
  return box.cv;
}

export async function getCv(): Promise<CV> {
  loading ??= (async () => {
    const cv: CV = await loadModule();
    if (!cv.Mat) await new Promise<void>((resolve) => { cv.onRuntimeInitialized = () => resolve(); });
    // Emscripten modules are thenables; resolving a promise with one would loop. Drop `then` once ready.
    if (typeof cv.then === 'function') delete cv.then;
    return { cv };
  })();
  return (await loading).cv;
}
