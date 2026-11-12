"""Calibration sheet: marker metadata, ArUco detection, homography and rectification."""
import json

import cv2
import numpy as np

from .constants import REGION, SCALE, SHEET_META, SHEET_PX


def load_meta(path=SHEET_META):
    """Read the marker metadata written by ``sheetgen.py``."""
    with open(path, encoding="utf-8") as f:
        return json.load(f)


META = load_meta()


def page_mm(meta=META):
    """Page size used for the search region: always the Letter entry."""
    return meta.get("pages", {}).get("letter", [215.9, 279.4])


def detect_markers(img, meta=META):
    """Return {marker id: 4x2 corner pixels} for every ArUco marker found."""
    d = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, meta["dict"]))
    det = cv2.aruco.ArucoDetector(d, cv2.aruco.DetectorParameters())
    corners, ids, _ = det.detectMarkers(img)
    found = {}
    if ids is not None:
        for c, i in zip(corners, ids.flatten()):
            found[int(i)] = c.reshape(4, 2)
    return found


def homography_img2mm(found, meta=META):
    """Homography from image pixels to sheet mm, or None with fewer than 2 markers."""
    src = []
    dst = []
    for mid, cmm in meta["markers"].items():
        mid = int(mid)
        if mid in found:
            src.extend(found[mid])
            dst.extend(cmm)
    if len(src) < 8:
        return None
    H, _ = cv2.findHomography(np.array(src, np.float32), np.array(dst, np.float32), cv2.RANSAC)
    return H


def rectify(img, H, region=REGION, scale=SCALE):
    """Warp the working area of the sheet to a top-down canvas at ``scale`` px/mm."""
    x0, y0, x1, y1 = region
    A = np.array([[scale, 0, -x0*scale], [0, scale, -y0*scale], [0, 0, 1]], np.float64)
    cw = int((x1-x0)*scale)
    ch = int((y1-y0)*scale)
    return cv2.warpPerspective(img, A @ H, (cw, ch)), (x0, y0)


def rect_region(img, H, region, meta=META, scale=SCALE):
    """Rectify any mm region of the tabletop plane (the homography is valid for
    the whole plane, not just the grid). Markers are whited-out so they can't be
    mistaken for the tool. Also returns a mask of pixels that came from the photo."""
    x0, y0, x1, y1 = region
    S = scale
    M = np.array([[S, 0, -x0*S], [0, S, -y0*S], [0, 0, 1]], float) @ H
    size = (int((x1-x0)*S), int((y1-y0)*S))
    can = cv2.warpPerspective(img, M, size, borderValue=(0, 0, 0))
    valid = cv2.warpPerspective(np.full(img.shape[:2], 255, np.uint8), M, size, flags=cv2.INTER_NEAREST)
    for cs in meta["markers"].values():
        c = np.array(cs)
        lo = c.min(0)-4
        hi = c.max(0)+4
        p0 = ((lo-[x0, y0])*S).astype(int)
        p1 = ((hi-[x0, y0])*S).astype(int)
        cv2.rectangle(can, tuple(p0), tuple(p1), (235, 235, 235), -1)
    return can, valid


def sheet_view(img, outline_sheet_mm, meta=META, scale=SHEET_PX):
    """JPEG of the whole perspective-corrected sheet the tool was shot on, plus its
    extent in sheet mm [x0, y0, x1, y1]. Expands past the paper if the tool
    (``outline_sheet_mm``, in sheet mm) hangs off it."""
    H = homography_img2mm(detect_markers(img, meta), meta)
    # crop to the sheet as defined by the 4 markers (outer edge of their white
    # quiet zone + a small margin) -- independent of Letter vs A4 paper
    mk = np.array([c for cs in meta["markers"].values() for c in cs], float)
    m = 0.18*meta.get("marker_edge_mm", 24.0) + 3.0
    x0, y0 = mk.min(0) - m
    x1, y1 = mk.max(0) + m
    Ps = np.asarray(outline_sheet_mm)                    # widen only if the tool hangs past it
    x0 = min(x0, Ps[:, 0].min()-6)
    y0 = min(y0, Ps[:, 1].min()-6)
    x1 = max(x1, Ps[:, 0].max()+6)
    y1 = max(y1, Ps[:, 1].max()+6)
    S = scale
    M = np.array([[S, 0, -x0*S], [0, S, -y0*S], [0, 0, 1]], float) @ H
    im = cv2.warpPerspective(img, M, (int((x1-x0)*S), int((y1-y0)*S)), borderValue=(28, 28, 30))
    ok, buf = cv2.imencode(".jpg", im, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return buf.tobytes(), [round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2)]
