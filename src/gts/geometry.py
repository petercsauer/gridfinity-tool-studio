"""2D geometry: outline smoothing, rotation, symmetry, pocket and footprint (all in mm)."""
import math

from dataclasses import dataclass

import numpy as np
from scipy.interpolate import splev, splprep
from shapely.geometry import LineString, Polygon

from .constants import GAP, GRID, LIP_INSET, MIN_WALL


def spline(C, sf=2.0, n=720):
    """Resample a closed contour by arc length and fit a periodic smoothing spline with n points."""
    seg = np.sqrt((np.diff(np.vstack([C, C[:1]]), axis=0)**2).sum(1))
    s = np.r_[0, np.cumsum(seg)]
    u = np.linspace(0, s[-1], n, endpoint=False)
    C = np.c_[np.interp(u, s, np.r_[C[:, 0], C[0, 0]]), np.interp(u, s, np.r_[C[:, 1], C[0, 1]])]
    tck, _ = splprep([C[:, 0], C[:, 1]], s=len(C)*sf, per=1)
    xs, ys = splev(np.linspace(0, 1, n), tck)
    return np.c_[xs, ys]


def rot_matrix(deg):
    """2x2 counter-clockwise rotation matrix."""
    t = math.radians(deg)
    c, s = math.cos(t), math.sin(t)
    return np.array([[c, -s], [s, c]])


def rotate(P, deg):
    """Rotate points about the origin by ``deg`` degrees."""
    return P @ rot_matrix(deg).T


@dataclass(frozen=True)
class SymmetricOutline:
    """A symmetric outline that contains the original tool, plus the mirror axis it was built
    around and the mirror IoU. The axis passes through ``centre + offset * (cos a, sin a)``
    at ``axis_deg`` (a) degrees from the y axis, where ``centre`` is the area centroid."""
    outline: np.ndarray
    score: float
    axis_deg: float
    offset: float
    centre: tuple


def _axis_frame(P, centre, deg, offset):
    """Points in the frame where the mirror axis (``deg``, ``offset``) is the line x = 0."""
    return (P - centre) @ rot_matrix(-deg).T - [offset, 0.0]


def mirror_score(P, centre, deg, offset=0.0):
    """IoU of the outline with its reflection about the axis ``deg``/``offset`` (see
    ``SymmetricOutline``); 1.0 for a perfectly symmetric outline."""
    Q = _axis_frame(P, centre, deg, offset)
    A, B = Polygon(Q).buffer(0), Polygon(Q*[-1, 1]).buffer(0)
    return A.intersection(B).area / A.union(B).area


def _best_axis(P, centre):
    """Best mirror axis (deg, offset): angle search through the centroid from -25 to 25 degrees
    in 0.5 degree steps, then two joint angle/offset grid refinements. The offset matters for
    long tools: a 0.25 mm shift of the axis can change the IoU by several percent."""
    def best(grid):
        return max(grid, key=lambda a: mirror_score(P, centre, *a))
    deg, off = best([(float(d), 0.0) for d in np.arange(-25, 25.01, 0.5)])
    deg, off = best([(deg+d, off+o) for d in np.arange(-1, 1.01, 0.25) for o in np.arange(-3, 3.01, 0.25)])
    deg, off = best([(deg+d, off+o) for d in np.arange(-0.25, 0.251, 0.05) for o in np.arange(-0.25, 0.251, 0.025)])
    return round(float(deg), 4), round(float(off), 4)


def resample(ring, n=720):
    """Resample a closed ring (Nx2, no closing point) to ``n`` points evenly spaced by arc length."""
    C = np.vstack([ring, ring[:1]])
    s = np.r_[0, np.cumsum(np.sqrt((np.diff(C, axis=0)**2).sum(1)))]
    u = np.linspace(0, s[-1], n, endpoint=False)
    return np.c_[np.interp(u, s, C[:, 0]), np.interp(u, s, C[:, 1])]


def symmetrize(P, smooth=1.0, n=720):
    """Make a symmetric tool's outline exactly symmetric without shrinking it or moving it.

    Finds the tool's own mirror axis (``_best_axis``: the best-matching line near the area
    centroid, not the bounding-box axis), takes the union of the outline and its reflection
    about that axis, and smooths the union's concave corners with a morphological closing of
    radius ``smooth`` mm, resampled to ``n`` points. The result is symmetric, always contains
    the original outline, and stays in the original pose so it still sits on the photo.
    Returns a ``SymmetricOutline`` whose ``score`` is the mirror IoU at the best axis (low
    scores mean the tool is not really symmetric)."""
    c = np.array(Polygon(P).buffer(0).centroid.coords[0])
    deg, off = _best_axis(P, c)
    Q = _axis_frame(P, c, deg, off)                   # mirror axis is now x = 0
    union = Polygon(Q).buffer(0).union(Polygon(Q*[-1, 1]).buffer(0))
    closed = largest_polygon(union.buffer(smooth, join_style=1, quad_segs=16)
                             .buffer(-smooth, join_style=1, quad_segs=16))
    S = ccw(resample(xy(closed), n)) + [off, 0.0]
    return SymmetricOutline(S @ rot_matrix(deg).T + c, float(mirror_score(P, c, deg, off)), deg, off, tuple(c))


SLOT_FRAC_RANGE = (0.02, 0.98)


def _line_coords(g):
    """All vertices of the line parts of a shapely intersection result (Nx2, possibly empty)."""
    if g.is_empty:
        return np.empty((0, 2))
    if g.geom_type == "LineString":
        return np.array(g.coords)
    if hasattr(g, "geoms"):
        parts = [_line_coords(p) for p in g.geoms if p.geom_type in ("LineString", "MultiLineString")]
        parts = [p for p in parts if len(p)]
        return np.vstack(parts) if parts else np.empty((0, 2))
    return np.empty((0, 2))


def make_pocket(P, clearance, slot_on, slot_r, slot_over, slot_frac):
    """Tool polygon and pocket polygon (tool grown by ``clearance`` plus a stadium finger slot
    across the tool at ``slot_frac`` of its height). ``slot_frac`` is clamped to
    ``SLOT_FRAC_RANGE``; if the slot line still misses the outline there is no slot."""
    tool = largest_polygon(Polygon(P).buffer(0))
    clr = largest_polygon(tool.buffer(clearance, join_style=1, quad_segs=16))
    if slot_on and slot_r > 0:
        frac = min(max(slot_frac, SLOT_FRAC_RANGE[0]), SLOT_FRAC_RANGE[1])
        ys = xy(clr)[:, 1]
        yy = ys.min() + frac*(ys.max()-ys.min())
        row = clr.intersection(LineString([(P[:, 0].min()-500, yy), (P[:, 0].max()+500, yy)]))
        xs = _line_coords(row)
        if len(xs):
            pill = LineString([(xs[:, 0].min()-slot_over, yy),
                               (xs[:, 0].max()+slot_over, yy)]).buffer(slot_r, cap_style=1, quad_segs=16)
            clr = largest_polygon(clr.union(pill))
    return tool, clr


def largest_polygon(g):
    """``g`` itself if it is a Polygon, else the largest polygon of a multi-part geometry."""
    if g.geom_type == "Polygon":
        return g
    polys = [p for p in getattr(g, "geoms", []) if p.geom_type == "Polygon"]
    if not polys:
        raise ValueError(f"Expected a polygon, got an empty {g.geom_type}.")
    return max(polys, key=lambda p: p.area)


def xy(g):
    """Exterior ring of a polygon (the largest one of a MultiPolygon) as an Nx2 array
    without the closing point."""
    return np.array(largest_polygon(g).exterior.coords)[:-1]


def ccw(p):
    """Return the ring in counter-clockwise order."""
    a = np.sum(p[:, 0]*np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1)*p[:, 1])
    return p if a > 0 else p[::-1]


def footprint(pocket_mm, fillet, grid=GRID):
    """Bin footprint in whole grid cells (nx, ny) that holds the pocket with its top round-over.

    Per axis the bin (``grid*n - GAP`` wide) must fit the pocket extent, the round-over that
    widens the opening by up to ``fillet`` per side, and the stacking-lip trough inset plus a
    minimum wall on each side: ``need = extent + 2*fillet + 2*(LIP_INSET + MIN_WALL) + GAP``."""
    margin = 2*max(0.0, fillet) + 2*(LIP_INSET + MIN_WALL) + GAP
    w = pocket_mm[:, 0].max()-pocket_mm[:, 0].min()
    h = pocket_mm[:, 1].max()-pocket_mm[:, 1].min()
    return int(math.ceil((w+margin)/grid)), int(math.ceil((h+margin)/grid))
