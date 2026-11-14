#!/usr/bin/env python3
"""Writes assets/presets/kit2.jpg, a two-part kit photo for the tests (run with python3 -I).

The flush cutter's photo with the needle-nose pliers pasted on the free paper to its left, upright, at the
same scale: the needle-nose's rectified image and mask (REGION at PX px/mm) are warped through the sheet frame
into the flush cutter's photo with its homography (photo px to sheet mm), and blended in by the mask.
"""
import json
import os

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRESETS = os.path.join(ROOT, "assets", "presets")
OUT = os.path.join(PRESETS, "kit2.jpg")
BASE, PASTE = "flushcutter", "needlenose"
PX = 8.0                    # px per mm of the rectified images (gts.constants.PX)
REGION_ORIGIN = (14.0, 56.0)  # sheet mm of the rectified images' top-left corner (gts.constants.REGION)
CENTRE = (37.0, 150.0)      # where the pasted part's centre lands on the sheet (mm)


def homography(tool):
    with open(os.path.join(ROOT, "tests", "fixtures", "presets", f"{tool}.json"), encoding="utf-8") as f:
        return np.array(json.load(f)["homography"], dtype=np.float64)


def paste_transform(mask):
    """3x3 map from sheet mm to the pasted tool's rectified px: its long axis turned upright, its centre at
    CENTRE."""
    ys, xs = np.nonzero(mask > 128)
    pts = np.c_[xs, ys].astype(np.float64)
    c = pts.mean(0)
    _, vecs = np.linalg.eigh(np.cov((pts - c).T))
    dx, dy = vecs[:, 1] * (1 if vecs[1, 1] >= 0 else -1)  # the long axis, pointing down the image
    # upright (long axis along y) to the source's orientation, about the tool's centre
    A = np.array([[dy, dx], [-dx, dy]])
    b = (c / PX + REGION_ORIGIN) - A @ np.array(CENTRE)
    to_px = np.array([[PX, 0, -REGION_ORIGIN[0] * PX], [0, PX, -REGION_ORIGIN[1] * PX], [0, 0, 1]])
    return to_px @ np.array([[A[0, 0], A[0, 1], b[0]], [A[1, 0], A[1, 1], b[1]], [0, 0, 1]])


def main():
    photo = cv2.imread(os.path.join(PRESETS, f"{BASE}.jpg"))
    rect = cv2.imread(os.path.join(PRESETS, f"{PASTE}_rect.png"))
    mask = cv2.imread(os.path.join(PRESETS, f"{PASTE}_mask.png"), cv2.IMREAD_GRAYSCALE)
    # photo px -> sheet mm -> pasted tool's rectified px, as warpPerspective's inverse map
    M = paste_transform(mask) @ homography(BASE)
    size = (photo.shape[1], photo.shape[0])
    flags = cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP
    tool = cv2.warpPerspective(rect, M, size, flags=flags, borderMode=cv2.BORDER_CONSTANT)
    # shrink the mask a little so none of the other photo's paper comes along, then soften its edge
    m = cv2.erode(mask, np.ones((3, 3), np.uint8))
    alpha = cv2.warpPerspective(m, M, size, flags=flags, borderMode=cv2.BORDER_CONSTANT).astype(np.float32) / 255
    alpha = cv2.GaussianBlur(alpha, (3, 3), 0)[..., None]
    out = (photo * (1 - alpha) + tool * alpha).round().astype(np.uint8)
    cv2.imwrite(OUT, out, [cv2.IMWRITE_JPEG_QUALITY, 90])
    print(f"{os.path.relpath(OUT, ROOT)}: {os.path.getsize(OUT)} bytes")


if __name__ == "__main__":
    main()
