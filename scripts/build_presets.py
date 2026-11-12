#!/usr/bin/env python3
"""Writes the web app's static preset data (web/public/presets/) and sheet PDFs (web/public/sheet/) from src/gts and assets/ (run with python3 -I)."""
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cv2
import numpy as np

from gts.constants import SHEET_DIR, SYM_DEFAULT, TOOLS
from gts.geometry import symmetrize
from gts.sheet import sheet_view
from gts.trace import load_preset, preset_paths
from make_fixtures import r4, up2sheet_affine, write as write_json

PUBLIC = os.path.join(ROOT, "web", "public")
PRESETS_OUT = os.path.join(PUBLIC, "presets")
SHEET_OUT = os.path.join(PUBLIC, "sheet")


def build_preset(tool):
    a = load_preset(tool)
    aff = up2sheet_affine(a.up2sheet)
    err = np.abs(a.outline @ aff[:, :2].T + aff[:, 2] - a.up2sheet(a.outline)).max()
    assert err < 1e-6, f"{tool}: up2sheet is not affine ({err})"
    sym = symmetrize(a.outline)
    jpg, box = sheet_view(cv2.imread(preset_paths(tool)[0]), a.up2sheet(a.outline))
    with open(os.path.join(PRESETS_OUT, f"{tool}-sheet.jpg"), "wb") as f:
        f.write(jpg)
    write_json(os.path.join(PRESETS_OUT, f"{tool}.json"), {
        "id": tool,
        "label": TOOLS[tool],
        "sym": SYM_DEFAULT[tool],
        "crop_mm": r4([a.crop_w, a.crop_h]),
        "outline_mm": r4(a.outline),
        "symmetric_outline_mm": r4(sym.outline),
        "symmetry_score": r4(sym.score),
        # the mirror axis passes through centre + offset * (cos a, sin a), a = deg from the y axis
        "symmetry_axis": {"deg": r4(sym.axis_deg), "offset": r4(sym.offset), "centre": r4(list(sym.centre))},
        "up2sheet": r4(aff),
        "sheet_box_mm": r4(box),
        "sheet_image": f"{tool}-sheet.jpg",
    })


def main():
    os.makedirs(PRESETS_OUT, exist_ok=True)
    os.makedirs(SHEET_OUT, exist_ok=True)
    for tool in TOOLS:
        build_preset(tool)
        print(f"{tool}: ok")
    write_json(os.path.join(PRESETS_OUT, "index.json"), {
        "presets": [{"id": t, "label": TOOLS[t], "sym": SYM_DEFAULT[t]} for t in TOOLS]})
    for size in ("letter", "a4"):
        shutil.copyfile(os.path.join(SHEET_DIR, f"calibration_sheet_{size}.pdf"), os.path.join(SHEET_OUT, f"{size}.pdf"))


if __name__ == "__main__":
    main()
