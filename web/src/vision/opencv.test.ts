import { describe, expect, it } from 'vitest';
import { getCv } from './opencv';

describe('getCv', () => {
  it('loads opencv.js with the ArUco detector and the functions the pipeline uses', async () => {
    const cv = await getCv();
    expect(typeof cv.Mat).toBe('function');
    expect(typeof cv.aruco_ArucoDetector).toBe('function');
    expect(cv.DICT_4X4_50).toBe(0);
    for (const fn of ['getPredefinedDictionary', 'findHomography', 'warpPerspective', 'findContours', 'minAreaRect', 'distanceTransform', 'resize', 'GaussianBlur', 'morphologyEx']) {
      expect(typeof cv[fn], fn).toBe('function');
    }
    expect(await getCv()).toBe(cv);
  });
});
