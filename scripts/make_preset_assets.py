#!/usr/bin/env python3
"""Makes a demo tool's assets/presets/ files (photo, rectified page, mask) from a calibration-sheet photo (run with python3 -I)."""
import argparse
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))

import cv2
import numpy as np

from gts.constants import PRESET_REGIONS, PRESETS_DIR, PX
from gts.sheet import detect_markers, homography_img2mm, rect_region
from gts.trace import largest_contour, preset_paths, rembg_mask


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("photo", help="photo of the tool on the printed calibration sheet (JPEG or PNG)")
    ap.add_argument("tool", help="preset id, listed in PRESET_REGIONS in src/gts/constants.py")
    a = ap.parse_args()
    region = PRESET_REGIONS[a.tool]
    img = cv2.imread(a.photo)
    if img is None:
        sys.exit(f"Can't read {a.photo}")
    H = homography_img2mm(detect_markers(img))
    if H is None:
        sys.exit("All four corner markers must be visible.")
    rect, _ = rect_region(img, H, region)
    # the same two passes as process_photo: find the tool on the whole page, then cut it out again from a
    # tight crop at full resolution, and paste that mask into the page frame
    x, y, w, h = cv2.boundingRect(largest_contour(rembg_mask(rect)))
    crop = (region[0] + x / PX - 15, region[1] + y / PX - 15, region[0] + (x + w) / PX + 15, region[1] + (y + h) / PX + 15)
    can, _ = rect_region(img, H, crop)
    tight = rembg_mask(can)
    tool = np.zeros_like(tight)
    cv2.drawContours(tool, [largest_contour(tight)], -1, 255, -1)
    mask = np.zeros(rect.shape[:2], np.uint8)
    ox, oy = round((crop[0] - region[0]) * PX), round((crop[1] - region[1]) * PX)
    hh, ww = tool.shape
    y0, x0 = max(0, oy), max(0, ox)
    y1, x1 = min(mask.shape[0], oy + hh), min(mask.shape[1], ox + ww)
    mask[y0:y1, x0:x1] = tool[y0 - oy:y1 - oy, x0 - ox:x1 - ox]
    photo, rect_path, mask_path = preset_paths(a.tool, PRESETS_DIR)
    cv2.imwrite(photo, img, [cv2.IMWRITE_JPEG_QUALITY, 92])  # re-encoded: no metadata is copied
    cv2.imwrite(rect_path, rect)
    cv2.imwrite(mask_path, mask)
    print(f"{a.tool}: wrote {os.path.relpath(photo, ROOT)}, _rect.png and _mask.png "
          f"(tool {w / PX:.0f} x {h / PX:.0f} mm)")


if __name__ == "__main__":
    main()
