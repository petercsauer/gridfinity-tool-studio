#!/usr/bin/env python3
"""Writes the JSON parity fixtures in tests/fixtures/ from the Python reference (run with python3 -I)."""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))

import cv2
import numpy as np

from gts.bin import genbin
from gts.constants import FIXTURE_TOOLS as TOOLS, PX, REGION, SYM_DEFAULT
from gts.geometry import footprint, make_pocket, symmetrize, xy
from gts.sheet import detect_markers, homography_img2mm
from gts.trace import largest_contour, load_preset, preset_paths

FIXTURES = os.path.join(ROOT, "tests", "fixtures")
DEFAULTS = {"clearance": 2.5, "rot": 0.0, "slotOn": True, "slotR": 12.5, "slotOver": 6.0,
            "slotFrac": 0.4, "u": 3, "depth": 10.0, "fillet": 3.175, "bfillet": 0.0}


def r4(a):
    """Round to 4 decimals (as nested lists for arrays), with -0.0 normalised to 0.0."""
    if isinstance(a, np.ndarray):
        return r4(a.tolist())
    if isinstance(a, (list, tuple)):
        return [r4(x) for x in a]
    return round(float(a), 4) + 0.0


def sig(a, digits=10):
    """Round to significant digits: homography entries span 1e-7 to 1e3, so fixed decimals lose them."""
    if isinstance(a, np.ndarray):
        return sig(a.tolist(), digits)
    if isinstance(a, (list, tuple)):
        return [sig(x, digits) for x in a]
    return float(f"{float(a):.{digits - 1}e}") + 0.0


def up2sheet_affine(t):
    """The UprightToSheet transform as a 2x3 affine [A | b]: sheet_mm = A @ q + b."""
    A = t.minv[:, :2]
    b = ((np.array([t.crop_w/2, t.crop_h/2])*t.px + [t.crop_x0, t.crop_y0]) @ A.T + t.minv[:, 2])/t.px \
        + np.asarray(t.origin)
    return np.c_[A, b]


def preset_fixture(tool):
    img = cv2.imread(preset_paths(tool)[0])
    found = detect_markers(img)
    H = homography_img2mm(found)
    if H is None:
        raise SystemExit(f"{tool}: not all calibration markers were found in the preset photo")
    a = load_preset(tool)
    aff = up2sheet_affine(a.up2sheet)
    err = np.abs(a.outline @ aff[:, :2].T + aff[:, 2] - a.up2sheet(a.outline)).max()
    assert err < 1e-6, f"{tool}: up2sheet is not affine ({err})"
    sym = symmetrize(a.outline)
    p = DEFAULTS
    P = sym.outline if SYM_DEFAULT[tool] else a.outline
    _, pocket = make_pocket(P, p["clearance"], p["slotOn"], p["slotR"], p["slotOver"], p["slotFrac"])
    pc = xy(pocket)
    nx, ny = footprint(pc, p["fillet"])
    pcc = pc - (pc.max(0) + pc.min(0))/2
    res = genbin(pcc, nx, ny, p["u"], p["depth"], p["fillet"], p["bfillet"])
    return {
        "tool": tool,
        "marker_corners_px": {str(i): r4(found[i]) for i in sorted(found)},
        "homography": sig(H),
        "outline_mm": r4(a.outline),
        "crop_mm": r4([a.crop_w, a.crop_h]),
        "up2sheet": r4(aff),
        "symmetric_outline_mm": r4(sym.outline),
        "symmetry_score": r4(sym.score),
        "symmetry_axis": {"deg": r4(sym.axis_deg), "offset_mm": r4(sym.offset), "centre_mm": r4(sym.centre)},
        "params": dict(p, sym=SYM_DEFAULT[tool]),
        "pocket_mm": r4(pc),
        "footprint": [nx, ny],
        "bin": {"bbox": r4(res.mesh.bounds), "volume_mm3": r4(res.mesh.volume),
                "effective_depth": r4(res.effective_depth)},
    }


def mask_fixture(tool):
    _, rect, mask_path = preset_paths(tool)
    m = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
    c = largest_contour(m)
    (cx, cy), (w, h), ang = cv2.minAreaRect(c.astype(np.float32))
    return {
        "tool": tool,
        "mask_png": os.path.relpath(mask_path, ROOT),
        "rect_png": os.path.relpath(rect, ROOT),
        "region_mm": list(REGION),
        "origin_mm": list(REGION[:2]),
        "px_per_mm": PX,
        "size_px": [int(m.shape[1]), int(m.shape[0])],
        "foreground_px": int((m > 128).sum()),
        "largest_contour_area_px": r4(cv2.contourArea(c)),
        "bbox_px": [int(v) for v in cv2.boundingRect(c)],
        "min_area_rect_px": {"centre": r4([cx, cy]), "size": r4([w, h]), "angle_deg": r4(ang)},
    }


def write(path, obj):
    """One top-level key per line, so diffs stay readable without a 720-line point list."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    body = ",\n".join(f"  {json.dumps(k)}: {json.dumps(v, separators=(',', ':'))}" for k, v in obj.items())
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("{\n" + body + "\n}\n")


def main():
    for tool in TOOLS:
        write(os.path.join(FIXTURES, "presets", f"{tool}.json"), preset_fixture(tool))
        write(os.path.join(FIXTURES, "masks", f"{tool}.json"), mask_fixture(tool))
        print(f"{tool}: ok")


if __name__ == "__main__":
    main()
