#!/usr/bin/env python3
"""Gridfinity Tool Studio — local web app: pick a tool photo, tune a gridfinity bin (clearance, finger
slot, height, floor, top fillet, rotation, cell size), preview the STL in 3D,
and export it. Backend reuses the rembg-derived outlines + manifold3d bin build.
Run with the project python:
  /opt/homebrew/opt/python@3.11/bin/python3.11 -I webapp/app.py  [--port 8765]
"""
import os, sys, io, json, base64, math, threading
import numpy as np, cv2, trimesh
from scipy.interpolate import splprep, splev
from shapely.geometry import Polygon, LineString
from shapely import affinity
from manifold3d import Manifold, CrossSection, JoinType, FillRule
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
import analyze_sheet as A                  # ArUco detect / homography / rectify

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "out")
PX = 8.0                                   # px per mm in rectified images
TOOLS = {"needlenose": "Needle-nose", "combopliers": "Combo pliers",
         "flushcutter": "Flush cutter", "stripper": "Wire stripper"}
SYM_DEFAULT = {"needlenose": True, "combopliers": True, "flushcutter": True, "stripper": False}

# ---- gridfinity constants (kennetek standard.scad) ----
GRID = 42.0; GAP = 0.5; UHT = 7.0; R_TOP = 3.75
PAD_TOP = 41.5; R_BOT = 0.8; PAD_BOTH = 35.6; PAD_MID = 37.2; R_MID = 1.6

# ===================== outline extraction (upright, mm) =====================
def _spline(C, sf=2.0, n=720):
    seg = np.sqrt((np.diff(np.vstack([C, C[:1]]), axis=0)**2).sum(1))
    s = np.r_[0, np.cumsum(seg)]; u = np.linspace(0, s[-1], n, endpoint=False)
    C = np.c_[np.interp(u, s, np.r_[C[:,0], C[0,0]]), np.interp(u, s, np.r_[C[:,1], C[0,1]])]
    tck, _ = splprep([C[:,0], C[:,1]], s=len(C)*sf, per=1); xs, ys = splev(np.linspace(0,1,n), tck)
    return np.c_[xs, ys]

def _largest(mask):
    c, _ = cv2.findContours((mask > 128).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    return max(c, key=cv2.contourArea)

_cache = {}; _labels = {}; _upn = [0]; _sess = [None]

def rembg_mask(bgr):
    """Run rembg (IS-Net) on a BGR image, return a single-channel mask."""
    from rembg import remove, new_session
    if _sess[0] is None: _sess[0] = new_session("isnet-general-use")
    m = remove(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), session=_sess[0], only_mask=True, post_process_mask=True)
    m = np.asarray(m)
    return m[:, :, 0] if m.ndim == 3 else m

_aff = {}; _sheet = {}; _src = {}
PRESETS = os.path.join(os.path.dirname(HERE), "assets", "presets")   # demo photos the built-in tools were traced from
SHEET_PX = 4.0                                # px/mm for the on-paper trace image

def build_assets(bg, mask, origin=(0.0, 0.0), key=None):
    """From a BGR image + mask (both at PX px/mm), make the upright crop +
    centred outline (mm). Returns (png_bytes, outline_mm, crop_w_mm, crop_h_mm)."""
    c = _largest(mask); (cx, cy), (w, h), ang = cv2.minAreaRect(c.astype(np.float32))
    if w > h: ang += 90
    H0, W0 = mask.shape; M = cv2.getRotationMatrix2D((cx, cy), ang, 1.0)
    cos, sin = abs(M[0,0]), abs(M[0,1]); nW = int(H0*sin+W0*cos); nH = int(H0*cos+W0*sin)
    M[0,2] += nW/2-cx; M[1,2] += nH/2-cy
    bg = cv2.warpAffine(bg, M, (nW, nH), borderValue=(32,34,38))
    mask = cv2.warpAffine(mask, M, (nW, nH), flags=cv2.INTER_NEAREST)
    x, y, w, h = cv2.boundingRect(_largest(mask)); pad = int(12*PX)
    x0, y0 = max(0, x-pad), max(0, y-pad); x1, y1 = min(nW, x+w+pad), min(nH, y+h+pad)
    bg = bg[y0:y1, x0:x1]; mask = mask[y0:y1, x0:x1]
    P = _spline(_largest(mask).reshape(-1,2).astype(float), 2.0) / PX
    cw, ch = bg.shape[1]/PX, bg.shape[0]/PX
    P = P - [cw/2, ch/2]
    if key is not None:
        # upright-centred mm  ->  sheet mm : invert crop offset, rotation, and canvas origin
        Minv = cv2.invertAffineTransform(M)
        def up2sheet(Q):
            px = (np.asarray(Q) + [cw/2, ch/2])*PX + [x0, y0]
            cpx = px @ Minv[:, :2].T + Minv[:, 2]
            return cpx/PX + np.asarray(origin)
        _aff[key] = up2sheet
    ok, buf = cv2.imencode(".png", bg)
    return (buf.tobytes(), P, cw, ch)

def tool_assets(tool):
    """Return (bg_png_bytes, outline_mm centred at origin, crop_w_mm, crop_h_mm)."""
    if tool in _cache: return _cache[tool]
    bg = cv2.imread(os.path.join(OUT, f"rectified_{tool}.png"))
    mask = cv2.imread(os.path.join(OUT, f"rembgmask_{tool}.png"), cv2.IMREAD_GRAYSCALE)
    _cache[tool] = build_assets(bg, mask, origin=A.REGION[:2], key=tool)
    _src[tool] = os.path.join(PRESETS, f"{tool}.jpg")
    return _cache[tool]

def sheet_view(tool):
    """JPEG of the whole perspective-corrected sheet the tool was shot on, plus its
    extent in sheet mm. Expands past the paper if the tool hangs off it."""
    if tool in _sheet: return _sheet[tool]
    tool_assets(tool) if tool in TOOLS else None
    img = _src[tool] if isinstance(_src[tool], np.ndarray) else cv2.imread(_src[tool])
    H = A.homography_img2mm(A.detect_markers(img))
    # crop to the sheet as defined by the 4 markers (outer edge of their white
    # quiet zone + a small margin) -- independent of Letter vs A4 paper
    mk = np.array([c for cs in A.META["markers"].values() for c in cs], float)
    m = 0.18*A.META.get("marker_edge_mm", 24.0) + 3.0
    x0, y0 = mk.min(0) - m; x1, y1 = mk.max(0) + m
    Ps = _aff[tool](_cache[tool][1])                     # widen only if the tool hangs past it
    x0 = min(x0, Ps[:,0].min()-6); y0 = min(y0, Ps[:,1].min()-6)
    x1 = max(x1, Ps[:,0].max()+6); y1 = max(y1, Ps[:,1].max()+6)
    S = SHEET_PX
    M = np.array([[S,0,-x0*S],[0,S,-y0*S],[0,0,1]], float) @ H
    im = cv2.warpPerspective(img, M, (int((x1-x0)*S), int((y1-y0)*S)), borderValue=(28,28,30))
    ok, buf = cv2.imencode(".jpg", im, [cv2.IMWRITE_JPEG_QUALITY, 88])
    _sheet[tool] = (buf.tobytes(), [round(x0,2), round(y0,2), round(x1,2), round(y1,2)])
    return _sheet[tool]

def decode_image(raw):
    """Decode uploaded bytes. OpenCV handles JPEG/PNG/etc.; anything it can't
    (HEIC/HEIF from iPhones, TIFF variants...) is converted by macOS `sips`."""
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is not None: return img
    import tempfile, subprocess
    with tempfile.TemporaryDirectory() as d:
        src, dst = os.path.join(d, "in"), os.path.join(d, "out.jpg")
        open(src, "wb").write(raw)
        subprocess.run(["sips", "-s", "format", "jpeg", src, "--out", dst],
                       capture_output=True, timeout=60)
        if os.path.exists(dst): img = cv2.imread(dst, cv2.IMREAD_COLOR)
    return img

def _rect_region(img, H, region):
    """Rectify any mm region of the tabletop plane (the homography is valid for
    the whole plane, not just the grid). Markers are whited-out so they can't be
    mistaken for the tool. Also returns a mask of pixels that came from the photo."""
    x0, y0, x1, y1 = region; S = A.SCALE
    M = np.array([[S,0,-x0*S],[0,S,-y0*S],[0,0,1]], float) @ H
    size = (int((x1-x0)*S), int((y1-y0)*S))
    can = cv2.warpPerspective(img, M, size, borderValue=(0,0,0))
    valid = cv2.warpPerspective(np.full(img.shape[:2], 255, np.uint8), M, size, flags=cv2.INTER_NEAREST)
    for cs in A.META["markers"].values():
        c = np.array(cs); lo = c.min(0)-4; hi = c.max(0)+4
        p0 = ((lo-[x0,y0])*S).astype(int); p1 = ((hi-[x0,y0])*S).astype(int)
        cv2.rectangle(can, tuple(p0), tuple(p1), (235,235,235), -1)
    return can, valid

def process_upload(img):
    """Calibration-sheet photo -> exact-mm tool outline. The tool may be larger
    than the grid and may extend off the paper, as long as all 4 markers are
    visible and the whole tool is in the photo. Raises ValueError otherwise."""
    found = A.detect_markers(img)
    H = A.homography_img2mm(found) if len(found) >= 4 else None
    if H is None:
        raise ValueError(f"No calibration sheet detected (found {len(found)} of 4 markers). "
                         "Photograph the tool on the printed calibration sheet with all four corner markers "
                         "visible and not covered by the tool.")
    pw, ph = A.META.get("page_mm", [215.9, 279.4])
    # pass 1: whole page + 40 mm margin, to find the tool wherever it is
    R1 = (-40, -40, pw+40, ph+40)
    can, valid = _rect_region(img, H, R1)
    m = rembg_mask(can)
    if (m > 128).sum() < (8*PX)**2:
        raise ValueError("Calibration sheet found, but no tool was detected on it.")
    c = _largest(m); x, y, w, h = cv2.boundingRect(c)
    bx0, by0 = R1[0]+x/PX, R1[1]+y/PX; bx1, by1 = bx0+w/PX, by0+h/PX
    # pass 2: tight crop around the tool at full resolution (precise edges)
    R2 = (bx0-15, by0-15, bx1+15, by1+15)
    canvas, valid = _rect_region(img, H, R2)
    mask = rembg_mask(canvas)
    if (mask > 128).sum() < (8*PX)**2:
        raise ValueError("Calibration sheet found, but no tool was detected on it.")
    tool = np.zeros_like(mask); cv2.drawContours(tool, [_largest(mask)], -1, 255, -1)
    edge = cv2.dilate(tool, np.ones((7,7), np.uint8)) & cv2.bitwise_not(valid)
    if edge.any() or tool[0].any() or tool[-1].any() or tool[:,0].any() or tool[:,-1].any():
        raise ValueError("Part of the tool is outside the photo. Step back so the whole tool and all four markers are in frame.")
    _upn[0] += 1; tid = f"up{_upn[0]}"; label = f"Upload {_upn[0]}"
    _cache[tid] = build_assets(canvas, mask, origin=R2[:2], key=tid); _labels[tid] = label
    _src[tid] = img
    return tid, label, _cache[tid]

def rotate(P, deg):
    t = math.radians(deg); c, s = math.cos(t), math.sin(t)
    R = np.array([[c, -s], [s, c]]); return P @ R.T

_symcache = {}
def _rot(th_deg):
    t = math.radians(th_deg); c, s = math.cos(t), math.sin(t)
    return np.array([[c, -s], [s, c]])

def symmetrize(tool, P):
    """Make a symmetric tool's outline exactly symmetric WITHOUT moving it:
    find the tool's own mirror axis (best-matching line through its centroid,
    not the bounding-box axis), average the shape with its reflection about
    that line (signed-distance average), and return it in the original pose so
    it still sits on the photo."""
    if tool in _symcache: return _symcache[tool]
    from scipy.ndimage import distance_transform_edt
    poly = Polygon(P).buffer(0); c = np.array(poly.centroid.coords[0])
    def score(th):
        Q = (P - c) @ _rot(-th).T
        A_, B_ = Polygon(Q).buffer(0), Polygon(Q*[-1, 1]).buffer(0)
        return A_.intersection(B_).area / A_.union(B_).area
    best = max(np.arange(-25, 25.01, 0.5), key=score)
    best = max(np.arange(best-0.5, best+0.51, 0.05), key=score)
    Q = (P - c) @ _rot(-best).T                       # mirror axis is now x = 0
    mn = Q.min(0); pad = 24
    R = (Q - mn)*PX + pad; x0 = -mn[0]*PX + pad       # pixel column of the axis
    W = int(R[:,0].max())+pad+2; Hh = int(R[:,1].max())+pad+2
    m = np.zeros((Hh, W), np.uint8); cv2.fillPoly(m, [R.astype(np.int32)], 1)
    Wm = int(max(W, 2*x0+2))
    m2 = np.zeros((Hh, Wm), np.uint8); m2[:, :W] = m
    mir = cv2.warpAffine(m2, np.float32([[-1,0,2*x0],[0,1,0]]), (Wm, Hh), flags=cv2.INTER_NEAREST)
    sdf = lambda a: distance_transform_edt(1-a) - distance_transform_edt(a)
    sym = (((sdf(m2)+sdf(mir))/2) <= 0).astype(np.uint8)
    cc = max(cv2.findContours(sym, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0], key=cv2.contourArea)
    Sl = (_spline(cc.reshape(-1,2).astype(float), 2.0) - pad)/PX + mn   # back to axis frame (mm)
    S = Sl @ _rot(best).T + c                          # back to the original pose
    _symcache[tool] = S
    return S

def make_pocket(P, clearance, slot_on, slot_r, slot_over, slot_frac):
    tool = Polygon(P).buffer(0)
    clr = tool.buffer(clearance, join_style=1, quad_segs=16)
    if slot_on and slot_r > 0:
        ys = np.array(clr.exterior.coords)[:,1]
        yy = ys.min() + slot_frac*(ys.max()-ys.min())
        row = clr.intersection(LineString([(P[:,0].min()-500, yy), (P[:,0].max()+500, yy)]))
        xs = np.array(row.coords) if row.geom_type == "LineString" else np.vstack([np.array(g.coords) for g in row.geoms])
        pill = LineString([(xs[:,0].min()-slot_over, yy), (xs[:,0].max()+slot_over, yy)]).buffer(slot_r, cap_style=1, quad_segs=16)
        clr = clr.union(pill)
    return tool, clr

def xy(g): return np.array(g.exterior.coords)[:-1]
def ccw(p):
    a = np.sum(p[:,0]*np.roll(p[:,1],-1) - np.roll(p[:,0],-1)*p[:,1])
    return p if a > 0 else p[::-1]

# ===================== manifold gridfinity bin =====================
def _rr(w, h, r):
    r = max(0.2, min(r, w/2-0.05, h/2-0.05))
    cs = CrossSection([[[-w/2+r,-h/2+r],[w/2-r,-h/2+r],[w/2-r,h/2-r],[-w/2+r,h/2-r]]], FillRule.Positive)
    return cs.offset(r, JoinType.Round, 2.0, 48)
def _slab(cs, z0, z1): return cs.extrude(z1-z0).translate([0,0,z0])
def _frustum(a, ra, z0, b, rb, z1):
    return (_slab(_rr(a,a,ra), z0, z0+0.02) + _slab(_rr(b,b,rb), z1-0.02, z1)).hull()
def _foot():
    return (_frustum(PAD_BOTH, R_BOT, 0.0, PAD_MID, R_MID, 0.8)
            + _slab(_rr(PAD_MID, PAD_MID, R_MID), 0.8, 2.6)
            + _frustum(PAD_MID, R_MID, 2.6, PAD_TOP, R_TOP, 4.75))

def genbin(pocket_mm, nx, ny, u, depth, fillet, bfillet=0.0):
    top = u*UHT; Dx = GRID*nx-GAP; Dy = GRID*ny-GAP
    recessZ = top - 4.4                                  # pocket opens at the recess floor
    floorTop = max(4.75+0.8, recessZ - depth)            # depth = pocket depth from the opening
    feet = Manifold()
    for i in range(nx):
        for j in range(ny):
            cx = (i+0.5)*GRID - GRID*nx/2; cy = (j+0.5)*GRID - GRID*ny/2
            feet += _foot().translate([cx, cy, 0])
    body = _slab(_rr(Dx, Dy, R_TOP), 4.75, top)
    binm = feet + body
    # stacking lip: chamfered perimeter trough
    rim = 1.8; lead = 1.4
    lip = (_slab(_rr(Dx-2*rim-2*lead, Dy-2*rim-2*lead, max(0.3,R_TOP-rim-lead)), top-4.4, top-4.38)
           + _slab(_rr(Dx-2*rim, Dy-2*rim, max(0.3,R_TOP-rim)), top-3.0, top+1)).hull()
    binm = binm - lip
    # tool pocket, with round-overs that follow the ACTUAL outline (stepped offset
    # layers, NO convex hull — hull would fill the concave jaw/handle gaps).
    pk = ccw(pocket_mm); poly = Polygon(pk); steps = 16
    ft = max(0.0, min(fillet,  (recessZ - floorTop) - 0.5))   # top: convex, flares OUT
    fb = max(0.0, min(bfillet, (recessZ - floorTop) - 0.5))   # bottom: concave, insets IN
    cutter = _slab(CrossSection([pk.tolist()], FillRule.Positive), floorTop+fb, top+1)
    def addring(geom, za, zb):
        g = geom if geom.geom_type == "Polygon" else max(geom.geoms, key=lambda x: x.area)
        if g.is_empty or g.area < 1.0: return
        cs = CrossSection([ccw(np.array(g.exterior.coords)[:-1]).tolist()], FillRule.Positive)
        nonlocal cutter; cutter += _slab(cs, za, zb)
    if ft > 0.05:
        for i in range(steps):
            d = i/steps*ft; off = ft - math.sqrt(max(0.0, ft*ft-(ft-d)**2))
            if off < 1e-3: continue
            addring(poly.buffer(off, join_style=1, quad_segs=24), recessZ-(i+1)/steps*ft-0.01, recessZ-i/steps*ft+0.01)
    if fb > 0.05:
        for i in range(steps):
            d = i/steps*fb; inset = fb - math.sqrt(max(0.0, fb*fb-(fb-d)**2))
            addring(poly.buffer(-inset, join_style=1, quad_segs=24), floorTop+i/steps*fb-0.01, floorTop+(i+1)/steps*fb+0.01)
    binm = binm - cutter
    m = binm.to_mesh()
    tm = trimesh.Trimesh(vertices=np.asarray(m.vert_properties)[:,:3], faces=np.asarray(m.tri_verts))
    return tm

def footprint(pocket_mm):
    w = pocket_mm[:,0].max()-pocket_mm[:,0].min(); h = pocket_mm[:,1].max()-pocket_mm[:,1].min()
    return int(math.ceil(w/GRID)), int(math.ceil(h/GRID))

# ===================== HTTP =====================
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)): body = json.dumps(body).encode()
        elif isinstance(body, str): body = body.encode()
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/" or p == "/index.html":
            self._send(200, open(os.path.join(HERE, "index.html")).read(), "text/html")
        elif p == "/tools":
            out = []
            for t, label in TOOLS.items():
                _, P, cw, ch = tool_assets(t)
                out.append({"id": t, "label": label, "cropW": round(cw,1), "cropH": round(ch,1), "sym": SYM_DEFAULT.get(t, False)})
            for t, label in _labels.items():
                _, P, cw, ch = _cache[t]
                out.append({"id": t, "label": label, "cropW": round(cw,1), "cropH": round(ch,1), "sym": False})
            self._send(200, out)
        elif p in ("/sheet/letter.pdf", "/sheet/a4.pdf"):
            size = p.split("/")[-1].split(".")[0]
            pdf = open(os.path.join(OUT, f"calibration_sheet_{size}.pdf"), "rb").read()
            self.send_response(200); self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Disposition", f'attachment; filename="tool-tracing-sheet-{size}.pdf"')
            self.send_header("Content-Length", str(len(pdf))); self.end_headers(); self.wfile.write(pdf)
        elif p.startswith("/sheetbg/"):
            t = p[len("/sheetbg/"):].rsplit(".", 1)[0]
            self._send(200, sheet_view(t)[0], "image/jpeg")
        elif p.startswith("/bg/"):
            t = p[4:].replace(".png", "")
            png, P, cw, ch = tool_assets(t)
            self._send(200, png, "image/png")
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(n) or b"{}")
        if self.path.split("?")[0] == "/upload":
            try:
                raw = base64.b64decode(req["image"].split(",")[-1])
                img = decode_image(raw)
                if img is None: raise ValueError("Couldn't read that file as an image (tried JPEG/PNG/HEIC).")
                tid, label, (png, P, cw, ch) = process_upload(img)
                if req.get("name"): _labels[tid] = label = req["name"][:40]
                self._send(200, {"id": tid, "label": label, "cropW": round(cw,1), "cropH": round(ch,1), "sym": False})
            except ValueError as e:
                self._send(400, {"error": str(e)})
            except Exception as e:
                self._send(500, {"error": f"Processing failed: {e}"})
            return
        t = req["tool"]; _, P0, cw, ch = tool_assets(t)
        if req.get("sym"): P0 = symmetrize(t, P0)
        P = rotate(P0, req.get("rot", 0))
        tool, pocket = make_pocket(P, req.get("clearance",2.5), req.get("slotOn",True),
                                   req.get("slotR",12.5), req.get("slotOver",6.0), req.get("slotFrac",0.4))
        pc = xy(pocket); tc = xy(tool)
        nx, ny = footprint(pc)
        if self.path.split("?")[0] == "/outline":
            st, sp = make_pocket(P0, req.get("clearance",2.5), req.get("slotOn",True),
                                 req.get("slotR",12.5), req.get("slotOver",6.0), req.get("slotFrac",0.4))
            f = _aff[t]
            self._send(200, {"sheetTool": f(xy(st)).round(2).tolist(), "sheetPocket": f(xy(sp)).round(2).tolist(),
                             "sheetBox": sheet_view(t)[1],"tool": tc.round(2).tolist(), "pocket": pc.round(2).tolist(),
                             "cropW": round(cw,1), "cropH": round(ch,1), "px": PX,
                             "nx": nx, "ny": ny, "w": round(pc[:,0].max()-pc[:,0].min(),1),
                             "h": round(pc[:,1].max()-pc[:,1].min(),1)})
            return
        # /generate
        pcc = pc - [(pc[:,0].max()+pc[:,0].min())/2, (pc[:,1].max()+pc[:,1].min())/2]
        tm = genbin(pcc, nx, ny, int(req.get("u",3)), req.get("depth",10.0), req.get("fillet",3.175), req.get("bfillet",0.0))
        buf = trimesh.exchange.stl.export_stl(tm)
        self._send(200, buf, "model/stl")

def main():
    port = 8765
    if "--port" in sys.argv: port = int(sys.argv[sys.argv.index("--port")+1])
    threading.Thread(target=lambda: rembg_mask(np.zeros((64,64,3),np.uint8)), daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    print(f"Gridfinity Tool Studio -> http://localhost:{port}")
    srv.serve_forever()

if __name__ == "__main__": main()
