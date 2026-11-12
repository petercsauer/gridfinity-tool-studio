#!/usr/bin/env python3
"""Gridfinity Tool Studio — local web app: pick a tool photo, tune a gridfinity bin (clearance, finger
slot, height, floor, top fillet, rotation, cell size), preview the STL in 3D,
and export it. Backend reuses the rembg-derived outlines + manifold3d bin build.
Run with the project python:
  /opt/homebrew/opt/python@3.11/bin/python3.11 -I webapp/app.py  [--port 8765]
"""
import os, sys, json, base64, threading
import numpy as np, cv2, trimesh
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
from gts.constants import PX, SHEET_DIR, SYM_DEFAULT, TOOLS
from gts.sheet import sheet_view as render_sheet_view
from gts.trace import decode_image, load_preset, preset_paths, process_photo, rembg_mask
from gts.geometry import footprint, make_pocket, rotate, symmetrize, xy
from gts.bin import genbin

HERE = os.path.dirname(os.path.abspath(__file__))

# per-process caches: tool id -> TraceAssets / label / source photo / sheet view / symmetric outline
_cache = {}; _labels = {}; _upn = [0]; _src = {}; _sheet = {}; _symcache = {}

def tool_assets(tool):
    """Return (bg_png_bytes, outline_mm centred at origin, crop_w_mm, crop_h_mm)."""
    if tool not in _cache:
        _cache[tool] = load_preset(tool)
        _src[tool] = preset_paths(tool)[0]
    a = _cache[tool]
    return (a.png, a.outline, a.crop_w, a.crop_h)

def sheet_view(tool):
    """JPEG of the whole perspective-corrected sheet the tool was shot on, plus its
    extent in sheet mm. Expands past the paper if the tool hangs off it."""
    if tool in _sheet: return _sheet[tool]
    tool_assets(tool) if tool in TOOLS else None
    img = _src[tool] if isinstance(_src[tool], np.ndarray) else cv2.imread(_src[tool])
    a = _cache[tool]
    _sheet[tool] = render_sheet_view(img, a.up2sheet(a.outline))
    return _sheet[tool]

def process_upload(img):
    """Trace an uploaded calibration-sheet photo and register it as a new tool."""
    assets = process_photo(img)
    _upn[0] += 1; tid = f"up{_upn[0]}"; label = f"Upload {_upn[0]}"
    _cache[tid] = assets; _labels[tid] = label
    _src[tid] = img
    return tid, label, (assets.png, assets.outline, assets.crop_w, assets.crop_h)

def symmetric_outline(tool, P):
    if tool not in _symcache: _symcache[tool] = symmetrize(P).outline
    return _symcache[tool]

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
            self._send(200, open(os.path.join(HERE, "index.html"), encoding="utf-8").read(), "text/html")
        elif p == "/tools":
            out = []
            for t, label in TOOLS.items():
                _, P, cw, ch = tool_assets(t)
                out.append({"id": t, "label": label, "cropW": round(cw,1), "cropH": round(ch,1), "sym": SYM_DEFAULT.get(t, False)})
            for t, label in _labels.items():
                _, P, cw, ch = tool_assets(t)
                out.append({"id": t, "label": label, "cropW": round(cw,1), "cropH": round(ch,1), "sym": False})
            self._send(200, out)
        elif p in ("/sheet/letter.pdf", "/sheet/a4.pdf"):
            size = p.split("/")[-1].split(".")[0]
            with open(os.path.join(SHEET_DIR, f"calibration_sheet_{size}.pdf"), "rb") as f: pdf = f.read()
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
        if req.get("sym"): P0 = symmetric_outline(t, P0)
        P = rotate(P0, req.get("rot", 0))
        tool, pocket = make_pocket(P, req.get("clearance",2.5), req.get("slotOn",True),
                                   req.get("slotR",12.5), req.get("slotOver",6.0), req.get("slotFrac",0.4))
        pc = xy(pocket); tc = xy(tool)
        nx, ny = footprint(pc, req.get("fillet",3.175))
        if self.path.split("?")[0] == "/outline":
            st, sp = make_pocket(P0, req.get("clearance",2.5), req.get("slotOn",True),
                                 req.get("slotR",12.5), req.get("slotOver",6.0), req.get("slotFrac",0.4))
            f = _cache[t].up2sheet
            self._send(200, {"sheetTool": f(xy(st)).round(2).tolist(), "sheetPocket": f(xy(sp)).round(2).tolist(),
                             "sheetBox": sheet_view(t)[1],"tool": tc.round(2).tolist(), "pocket": pc.round(2).tolist(),
                             "cropW": round(cw,1), "cropH": round(ch,1), "px": PX,
                             "nx": nx, "ny": ny, "w": round(pc[:,0].max()-pc[:,0].min(),1),
                             "h": round(pc[:,1].max()-pc[:,1].min(),1)})
            return
        # /generate
        pcc = pc - [(pc[:,0].max()+pc[:,0].min())/2, (pc[:,1].max()+pc[:,1].min())/2]
        tm = genbin(pcc, nx, ny, int(req.get("u",3)), req.get("depth",10.0), req.get("fillet",3.175), req.get("bfillet",0.0)).mesh
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
