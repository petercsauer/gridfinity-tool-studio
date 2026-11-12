// Shared lazy loader for opencv.js (@techstark/opencv-js). Works in the Web Worker and in Vitest (node).
// The ArUco detector in this build is exposed as cv.aruco_ArucoDetector; dictionaries via cv.getPredefinedDictionary.
// Every cv.Mat / cv.MatVector you create must be .delete()d.

// opencv.js ships no usable types for its emscripten API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any;

let loading: Promise<CV> | null = null;

export function getCv(): Promise<CV> {
  if (!loading) {
    loading = (async () => {
      const mod = await import('@techstark/opencv-js');
      let cv: CV = (mod as { default?: unknown }).default ?? mod;
      if (cv instanceof Promise) cv = await cv;
      else if (!cv.Mat) await new Promise<void>((resolve) => { cv.onRuntimeInitialized = () => resolve(); });
      return cv;
    })();
  }
  return loading;
}
