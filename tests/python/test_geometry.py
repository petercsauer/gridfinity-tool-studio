"""Geometry and validation fixes: bin sizing (Issue 4), edge inputs (Issue 5),
containment-preserving symmetry (Issue 7) and effective pocket depth (Issue 8)."""
import itertools

import cv2
import numpy as np
import pytest
from shapely.geometry import MultiPolygon, Polygon, box

from gts.bin import genbin, max_depth
from gts.constants import GAP, GRID, LIP_INSET, MIN_WALL, FIXTURE_TOOLS as TOOLS
from gts.geometry import footprint, make_pocket, mirror_score, rotate, symmetrize, xy
from gts.sheet import META, detect_markers, missing_markers
from gts.trace import decode_image, load_preset, preset_paths, process_photo

ROTATIONS = (0, 15, 20, 30, 45, 60, 90)
CLEARANCES = (0.0, 2.5, 5.0)
FILLETS = (0.0, 3.2, 6.0)
# genbin is the slow part (~0.5 s each), so the single-body check runs on the extremes of
# the clearance/fillet grid at every rotation; the cheap containment check runs on all of it
BODY_CASES = ((0.0, 0.0), (2.5, 3.2), (5.0, 6.0))


@pytest.fixture(scope="module")
def outlines():
    return {t: load_preset(t).outline for t in TOOLS}


@pytest.fixture(scope="module")
def symmetric(outlines):
    return {t: symmetrize(P) for t, P in outlines.items()}


def _centred_pocket(P, rot, clearance):
    _, pocket = make_pocket(rotate(P, rot), clearance, True, 12.5, 6.0, 0.4)
    pc = xy(pocket)
    return pc - (pc.max(0) + pc.min(0))/2


def _inner_rect(nx, ny):
    """The bin top shrunk by the lip trough inset and the minimum wall."""
    m = LIP_INSET + MIN_WALL
    hx, hy = (GRID*nx - GAP)/2 - m, (GRID*ny - GAP)/2 - m
    return box(-hx, -hy, hx, hy)


def test_footprint_rule_at_exact_multiples():
    margin = 2*3.0 + 2*(LIP_INSET + MIN_WALL) + GAP
    w = 2*GRID - margin                                       # needs exactly two cells
    pocket = np.array([[0, 0], [w, 0], [w, w], [0, w]])
    assert footprint(pocket, 3.0) == (2, 2)
    assert footprint(pocket + [[0, 0], [0.01, 0], [0.01, 0], [0, 0]], 3.0) == (3, 2)


@pytest.mark.parametrize("tool", list(TOOLS))
def test_pocket_with_fillet_fits_inside_lip_and_wall(outlines, tool):
    for rot, clr, fil in itertools.product(ROTATIONS, CLEARANCES, FILLETS):
        pc = _centred_pocket(outlines[tool], rot, clr)
        nx, ny = footprint(pc, fil)
        assert _inner_rect(nx, ny).covers(Polygon(pc).buffer(fil)), (rot, clr, fil)


@pytest.mark.parametrize("tool,rot", list(itertools.product(TOOLS, ROTATIONS)))
def test_generated_bin_is_one_watertight_body(outlines, tool, rot):
    for clr, fil in BODY_CASES:
        pc = _centred_pocket(outlines[tool], rot, clr)
        nx, ny = footprint(pc, fil)
        mesh = genbin(pc, nx, ny, 3, 10.0, fil).mesh
        assert mesh.is_watertight, (clr, fil)
        assert len(mesh.split(only_watertight=False)) == 1, (clr, fil)


def test_needlenose_rotated_20_is_one_body(outlines):
    """The reproduced Issue 4 failure: an 85.8 mm pocket that used to cut through a 3-cell bin."""
    pc = _centred_pocket(outlines["needlenose"], 20, 2.0)
    assert pc[:, 0].max() - pc[:, 0].min() == pytest.approx(85.8, abs=0.1)
    nx, ny = footprint(pc, 3.175)
    assert nx == 3 and ny == 5
    mesh = genbin(pc, nx, ny, 3, 10.0, 3.175).mesh
    assert mesh.is_watertight
    assert len(mesh.split(only_watertight=False)) == 1


@pytest.mark.parametrize("frac", [0.0, 1.0, 0.5, -3.0, 7.0])
def test_slot_fraction_edges_make_a_valid_pocket(outlines, frac):
    tool, pocket = make_pocket(outlines["needlenose"], 2.5, True, 12.5, 6.0, frac)
    assert pocket.geom_type == "Polygon" and pocket.is_valid
    assert pocket.area > tool.area


def test_xy_takes_the_largest_polygon_of_a_multipolygon():
    small = box(0, 0, 1, 1)
    big = box(10, 10, 20, 30)
    ring = xy(MultiPolygon([small, big]))
    assert Polygon(ring).area == pytest.approx(big.area)


@pytest.mark.parametrize("tool", list(TOOLS))
def test_symmetric_outline_contains_the_tool(outlines, symmetric, tool):
    S = symmetric[tool]
    original = Polygon(outlines[tool]).buffer(0)
    sym = Polygon(S.outline)
    assert sym.is_valid
    assert S.outline.shape == (720, 2)
    assert original.difference(sym).area < 1.0


@pytest.mark.parametrize("tool", list(TOOLS))
def test_symmetric_outline_is_mirror_symmetric(symmetric, tool):
    S = symmetric[tool]
    assert mirror_score(S.outline, np.array(S.centre), S.axis_deg, S.offset) > 0.995


def test_symmetry_scores_separate_symmetric_tools(symmetric):
    for tool in ("needlenose", "combopliers", "flushcutter"):
        assert symmetric[tool].score > 0.92, tool
    assert symmetric["stripper"].score < 0.92


def test_symmetric_outline_stays_in_the_upright_pose(outlines, symmetric):
    """The axis search stays near the outline's own frame, so the trace still overlays the photo."""
    for tool, S in symmetric.items():
        assert abs(S.axis_deg) <= 26
        c0 = Polygon(outlines[tool]).centroid
        assert c0.distance(Polygon(S.outline).centroid) < 5.0


@pytest.mark.parametrize("u,depth", [(3, 10.0), (3, 11.05), (3, 20.0), (4, 30.0), (2, 1.0), (1, 5.0)])
def test_effective_depth(u, depth):
    pc = np.array([[-20, -30], [20, -30], [20, 30], [-20, 30]], float)
    nx, ny = footprint(pc, 1.0)
    r = genbin(pc, nx, ny, u, depth, 1.0)
    expected = min(depth, max_depth(u))
    assert r.effective_depth == pytest.approx(expected, abs=1e-9)
    assert (r.nx, r.ny) == (nx, ny)
    assert r.mesh.is_watertight


def test_max_depth():
    assert max_depth(3) == pytest.approx(3*7 - 4.4 - 5.55)
    assert max_depth(6) == pytest.approx(6*7 - 4.4 - 5.55)
    assert max_depth(1) == 0.0


def _blank_marker(img, corners, pad=12):
    out = img.copy()
    c = corners.astype(np.float32)
    centre = c.mean(0)
    grown = centre + (c - centre)*1.4
    cv2.fillConvexPoly(out, grown.astype(np.int32), (255, 255, 255))
    lo, hi = grown.min(0).astype(int) - pad, grown.max(0).astype(int) + pad
    cv2.rectangle(out, tuple(lo), tuple(hi), (255, 255, 255), -1)
    return out


def test_marker_detection_rejects_a_missing_marker():
    img = cv2.imread(preset_paths("needlenose")[0])
    found = detect_markers(img)
    blanked = _blank_marker(img, found[3])
    assert set(detect_markers(blanked)) == {0, 1, 2}
    assert missing_markers(detect_markers(blanked)) == [3]
    with pytest.raises(ValueError, match="missing 3"):
        process_photo(blanked, segment=lambda bgr: pytest.fail("segmentation must not run"))


def test_marker_detection_ignores_extra_ids():
    img = cv2.imread(preset_paths("needlenose")[0])
    d = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, META["dict"]))
    tag = cv2.aruco.generateImageMarker(d, 9, 160)
    canvas = np.full((img.shape[0] + 400, img.shape[1], 3), 255, np.uint8)
    canvas[:img.shape[0]] = img
    canvas[img.shape[0]+120:img.shape[0]+280, 120:280] = tag[:, :, None]
    assert set(detect_markers(canvas)) == {0, 1, 2, 3}


def test_decode_image_handles_jpeg_garbage_and_heic_without_pillow_heif(monkeypatch):
    with open(preset_paths("needlenose")[0], "rb") as f:
        img = decode_image(f.read())
    assert img is not None and img.ndim == 3
    assert decode_image(b"not an image at all") is None
    monkeypatch.setitem(__import__("sys").modules, "pillow_heif", None)  # simulate "not installed"
    with pytest.raises(ValueError, match="pillow-heif"):
        decode_image(b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic")
