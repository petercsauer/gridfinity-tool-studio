// Static import wrapped in a plain object. opencv.js's CommonJS export has a `then`, so a namespace that
// re-exported it directly would be treated as a thenable by `await import()`. Loaded lazily by opencv.ts.
import cv from '@techstark/opencv-js';

export const box: { cv: unknown } = { cv };
