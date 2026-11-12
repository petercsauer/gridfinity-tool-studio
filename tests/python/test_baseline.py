"""Behavior-preserving baseline for the gts reference package.

The expected values were measured with the pre-refactor webapp/app.py, so these
tests pin the extraction into src/gts to the old behavior.
"""
import json

import cv2
import numpy as np
import pytest

import sheetgen
from gts.bin import genbin
from gts.constants import SHEET_META, SYM_DEFAULT, TOOLS
from gts.geometry import footprint, make_pocket, symmetrize, xy
from gts.sheet import detect_markers, load_meta, sheet_view
from gts.trace import load_preset, preset_paths

# minAreaRect (short, long) side of the upright outline in mm, measured before the refactor
OUTLINE_MM = {
    "needlenose": (55.798, 168.508),
    "combopliers": (56.314, 186.210),
    "flushcutter": (84.083, 128.533),
    "stripper": (59.691, 193.776),
}
SHEET_BOX = [10.68, 14.68, 205.22, 264.72]


@pytest.fixture(scope="module", params=list(TOOLS))
def preset(request):
    return request.param, load_preset(request.param)


def test_preset_outline_size_matches_pre_refactor(preset):
    tool, a = preset
    (_, _), (w, h), _ = cv2.minAreaRect(a.outline.astype(np.float32))
    short, long_ = sorted([w, h])
    exp_short, exp_long = OUTLINE_MM[tool]
    assert abs(short - exp_short) < 0.2
    assert abs(long_ - exp_long) < 0.2
    assert a.outline.shape == (720, 2)


def _default_bin(tool, outline):
    P = symmetrize(outline).outline if SYM_DEFAULT[tool] else outline
    _, pocket = make_pocket(P, 2.5, True, 12.5, 6.0, 0.4)
    pc = xy(pocket)
    nx, ny = footprint(pc, 3.175)
    pcc = pc - [(pc[:, 0].max()+pc[:, 0].min())/2, (pc[:, 1].max()+pc[:, 1].min())/2]
    return genbin(pcc, nx, ny, 3, 10.0, 3.175, 0.0).mesh


@pytest.mark.parametrize("tool", list(TOOLS))
def test_default_bin_is_watertight(tool):
    assert _default_bin(tool, load_preset(tool).outline).is_watertight


@pytest.mark.parametrize("tool", list(TOOLS))
def test_markers_detected_on_preset_photo(tool):
    img = cv2.imread(preset_paths(tool)[0])
    assert set(detect_markers(img)) >= {0, 1, 2, 3}


def test_sheet_view_extent_matches_pre_refactor(preset):
    tool, a = preset
    img = cv2.imread(preset_paths(tool)[0])
    jpg, box = sheet_view(img, a.up2sheet(a.outline))
    assert jpg[:2] == b"\xff\xd8"
    assert box == SHEET_BOX


def test_up2sheet_places_outline_inside_rectified_region(preset):
    _, a = preset
    S = a.up2sheet(a.outline)
    assert S[:, 0].min() > 14 and S[:, 0].max() < 201
    assert S[:, 1].min() > 56 and S[:, 1].max() < 226


@pytest.mark.parametrize("size", ["letter", "a4"])
def test_sheetgen_keeps_marker_coordinates(tmp_path, size):
    committed = load_meta(SHEET_META)
    sheetgen.main(size, str(tmp_path))
    with open(tmp_path / "sheet_markers.json", encoding="utf-8") as f:
        written = json.load(f)
    assert written["markers"] == committed["markers"]
    assert written["pages"] == {"letter": [215.9, 279.4], "a4": [210.0, 297.0]}
    assert "page_mm" not in written
    assert (tmp_path / f"calibration_sheet_{size}.pdf").stat().st_size > 0
