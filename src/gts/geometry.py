"""2D geometry: outline smoothing, rotation, symmetry, pocket and footprint (all in mm)."""
import math

import cv2
import numpy as np
from scipy.interpolate import splev, splprep
from shapely.geometry import LineString, Polygon

from .constants import GRID, PX


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


def symmetrize(P, px=PX):
    """Make a symmetric tool's outline exactly symmetric without moving it:
    find the tool's own mirror axis (best-matching line through its centroid,
    not the bounding-box axis), average the shape with its reflection about
    that line (signed-distance average), and return it in the original pose so
    it still sits on the photo."""
    from scipy.ndimage import distance_transform_edt
    poly = Polygon(P).buffer(0)
    c = np.array(poly.centroid.coords[0])

    def score(th):
        Q = (P - c) @ rot_matrix(-th).T
        A_, B_ = Polygon(Q).buffer(0), Polygon(Q*[-1, 1]).buffer(0)
        return A_.intersection(B_).area / A_.union(B_).area

    best = max(np.arange(-25, 25.01, 0.5), key=score)
    best = max(np.arange(best-0.5, best+0.51, 0.05), key=score)
    Q = (P - c) @ rot_matrix(-best).T                 # mirror axis is now x = 0
    mn = Q.min(0)
    pad = 24
    R = (Q - mn)*px + pad
    x0 = -mn[0]*px + pad                              # pixel column of the axis
    W = int(R[:, 0].max())+pad+2
    Hh = int(R[:, 1].max())+pad+2
    m = np.zeros((Hh, W), np.uint8)
    cv2.fillPoly(m, [R.astype(np.int32)], 1)
    Wm = int(max(W, 2*x0+2))
    m2 = np.zeros((Hh, Wm), np.uint8)
    m2[:, :W] = m
    mir = cv2.warpAffine(m2, np.float32([[-1, 0, 2*x0], [0, 1, 0]]), (Wm, Hh), flags=cv2.INTER_NEAREST)

    def sdf(a):
        return distance_transform_edt(1-a) - distance_transform_edt(a)

    sym = (((sdf(m2)+sdf(mir))/2) <= 0).astype(np.uint8)
    cc = max(cv2.findContours(sym, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0], key=cv2.contourArea)
    Sl = (spline(cc.reshape(-1, 2).astype(float), 2.0) - pad)/px + mn   # back to axis frame (mm)
    return Sl @ rot_matrix(best).T + c                 # back to the original pose


def make_pocket(P, clearance, slot_on, slot_r, slot_over, slot_frac):
    """Tool polygon and pocket polygon (tool grown by ``clearance`` plus a stadium finger slot
    across the tool at ``slot_frac`` of its height)."""
    tool = Polygon(P).buffer(0)
    clr = tool.buffer(clearance, join_style=1, quad_segs=16)
    if slot_on and slot_r > 0:
        ys = np.array(clr.exterior.coords)[:, 1]
        yy = ys.min() + slot_frac*(ys.max()-ys.min())
        row = clr.intersection(LineString([(P[:, 0].min()-500, yy), (P[:, 0].max()+500, yy)]))
        xs = (np.array(row.coords) if row.geom_type == "LineString"
              else np.vstack([np.array(g.coords) for g in row.geoms]))
        pill = LineString([(xs[:, 0].min()-slot_over, yy),
                           (xs[:, 0].max()+slot_over, yy)]).buffer(slot_r, cap_style=1, quad_segs=16)
        clr = clr.union(pill)
    return tool, clr


def xy(g):
    """Exterior ring of a polygon as an Nx2 array without the closing point."""
    return np.array(g.exterior.coords)[:-1]


def ccw(p):
    """Return the ring in counter-clockwise order."""
    a = np.sum(p[:, 0]*np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1)*p[:, 1])
    return p if a > 0 else p[::-1]


def footprint(pocket_mm, grid=GRID):
    """Bin footprint in whole grid cells (nx, ny) that spans the pocket's extent."""
    w = pocket_mm[:, 0].max()-pocket_mm[:, 0].min()
    h = pocket_mm[:, 1].max()-pocket_mm[:, 1].min()
    return int(math.ceil(w/grid)), int(math.ceil(h/grid))
