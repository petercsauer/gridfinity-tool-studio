"""Watertight gridfinity bin with a tool pocket, built with manifold3d."""
import math

import numpy as np
import trimesh
from manifold3d import CrossSection, FillRule, JoinType, Manifold
from shapely.geometry import Polygon

from .constants import GAP, GRID, PAD_BOTH, PAD_MID, PAD_TOP, R_BOT, R_MID, R_TOP, UHT
from .geometry import ccw


def _rr(w, h, r):
    """Rounded rectangle cross-section centred at the origin."""
    r = max(0.2, min(r, w/2-0.05, h/2-0.05))
    cs = CrossSection([[[-w/2+r, -h/2+r], [w/2-r, -h/2+r], [w/2-r, h/2-r], [-w/2+r, h/2-r]]], FillRule.Positive)
    return cs.offset(r, JoinType.Round, 2.0, 48)


def _slab(cs, z0, z1):
    return cs.extrude(z1-z0).translate([0, 0, z0])


def _frustum(a, ra, z0, b, rb, z1):
    return (_slab(_rr(a, a, ra), z0, z0+0.02) + _slab(_rr(b, b, rb), z1-0.02, z1)).hull()


def _foot():
    return (_frustum(PAD_BOTH, R_BOT, 0.0, PAD_MID, R_MID, 0.8)
            + _slab(_rr(PAD_MID, PAD_MID, R_MID), 0.8, 2.6)
            + _frustum(PAD_MID, R_MID, 2.6, PAD_TOP, R_TOP, 4.75))


def genbin(pocket_mm, nx, ny, u, depth, fillet, bfillet=0.0):
    """Build an nx x ny cell, u-unit-high bin with ``pocket_mm`` (centred, mm) cut ``depth`` mm deep
    below the stacking-lip recess, with a top round-over ``fillet`` and bottom round ``bfillet``.
    Returns a trimesh.Trimesh."""
    top = u*UHT
    Dx = GRID*nx-GAP
    Dy = GRID*ny-GAP
    recessZ = top - 4.4                                  # pocket opens at the recess floor
    floorTop = max(4.75+0.8, recessZ - depth)            # depth = pocket depth from the opening
    feet = Manifold()
    for i in range(nx):
        for j in range(ny):
            cx = (i+0.5)*GRID - GRID*nx/2
            cy = (j+0.5)*GRID - GRID*ny/2
            feet += _foot().translate([cx, cy, 0])
    body = _slab(_rr(Dx, Dy, R_TOP), 4.75, top)
    binm = feet + body
    # stacking lip: chamfered perimeter trough
    rim = 1.8
    lead = 1.4
    lip = (_slab(_rr(Dx-2*rim-2*lead, Dy-2*rim-2*lead, max(0.3, R_TOP-rim-lead)), top-4.4, top-4.38)
           + _slab(_rr(Dx-2*rim, Dy-2*rim, max(0.3, R_TOP-rim)), top-3.0, top+1)).hull()
    binm = binm - lip
    # tool pocket, with round-overs that follow the actual outline (stepped offset
    # layers, no convex hull: a hull would fill the concave jaw/handle gaps).
    pk = ccw(pocket_mm)
    poly = Polygon(pk)
    steps = 16
    ft = max(0.0, min(fillet,  (recessZ - floorTop) - 0.5))   # top: convex, flares out
    fb = max(0.0, min(bfillet, (recessZ - floorTop) - 0.5))   # bottom: concave, insets in
    cutter = _slab(CrossSection([pk.tolist()], FillRule.Positive), floorTop+fb, top+1)

    def addring(geom, za, zb):
        nonlocal cutter
        g = geom if geom.geom_type == "Polygon" else max(geom.geoms, key=lambda x: x.area)
        if g.is_empty or g.area < 1.0:
            return
        cs = CrossSection([ccw(np.array(g.exterior.coords)[:-1]).tolist()], FillRule.Positive)
        cutter += _slab(cs, za, zb)

    if ft > 0.05:
        for i in range(steps):
            d = i/steps*ft
            off = ft - math.sqrt(max(0.0, ft*ft-(ft-d)**2))
            if off < 1e-3:
                continue
            addring(poly.buffer(off, join_style=1, quad_segs=24), recessZ-(i+1)/steps*ft-0.01, recessZ-i/steps*ft+0.01)
    if fb > 0.05:
        for i in range(steps):
            d = i/steps*fb
            inset = fb - math.sqrt(max(0.0, fb*fb-(fb-d)**2))
            addring(poly.buffer(-inset, join_style=1, quad_segs=24), floorTop+i/steps*fb-0.01, floorTop+(i+1)/steps*fb+0.01)
    binm = binm - cutter
    m = binm.to_mesh()
    return trimesh.Trimesh(vertices=np.asarray(m.vert_properties)[:, :3], faces=np.asarray(m.tri_verts))
