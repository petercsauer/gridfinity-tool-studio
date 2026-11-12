"""Photo to tool outline: decoding, background removal and the upright, centred outline (mm)."""
import io
import os
import threading
from dataclasses import dataclass

import cv2
import numpy as np

from .constants import PRESET_REGIONS, PRESETS_DIR, PX, REGION
from .geometry import spline
from .sheet import META, detect_markers, homography_img2mm, missing_markers, page_mm, rect_region


@dataclass(frozen=True)
class UprightToSheet:
    """Maps upright-centred outline mm back to sheet mm: undo the crop offset,
    the upright rotation and the canvas origin."""
    minv: np.ndarray          # 2x3 inverse of the upright rotation (canvas px <- upright px)
    crop_w: float             # crop size in mm
    crop_h: float
    crop_x0: int              # crop offset in upright px
    crop_y0: int
    origin: tuple             # sheet-mm position of the canvas origin
    px: float = PX

    def __call__(self, Q):
        px = (np.asarray(Q) + [self.crop_w/2, self.crop_h/2])*self.px + [self.crop_x0, self.crop_y0]
        cpx = px @ self.minv[:, :2].T + self.minv[:, 2]
        return cpx/self.px + np.asarray(self.origin)


@dataclass(frozen=True)
class TraceAssets:
    """Upright crop of the tool (PNG), its centred outline in mm, the crop size in mm,
    and the transform from the outline frame to sheet mm."""
    png: bytes
    outline: np.ndarray
    crop_w: float
    crop_h: float
    up2sheet: UprightToSheet


def largest_contour(mask):
    """Largest external contour of a 0-255 mask thresholded at 128."""
    c, _ = cv2.findContours((mask > 128).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    return max(c, key=cv2.contourArea)


_sess = None
_sess_lock = threading.Lock()


def _rembg_session():
    global _sess
    with _sess_lock:
        if _sess is None:
            from rembg import new_session
            _sess = new_session("isnet-general-use")
        return _sess


def rembg_mask(bgr):
    """Run rembg (IS-Net) on a BGR image, return a single-channel mask."""
    from rembg import remove
    m = remove(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), session=_rembg_session(), only_mask=True, post_process_mask=True)
    m = np.asarray(m)
    return m[:, :, 0] if m.ndim == 3 else m


def build_assets(bg, mask, origin=(0.0, 0.0), px=PX):
    """From a BGR image + mask (both at ``px`` px/mm, canvas origin at ``origin`` sheet mm),
    make the upright crop and centred outline (mm)."""
    c = largest_contour(mask)
    (cx, cy), (w, h), ang = cv2.minAreaRect(c.astype(np.float32))
    if w > h:
        ang += 90
    H0, W0 = mask.shape
    M = cv2.getRotationMatrix2D((cx, cy), ang, 1.0)
    cos, sin = abs(M[0, 0]), abs(M[0, 1])
    nW = int(H0*sin+W0*cos)
    nH = int(H0*cos+W0*sin)
    M[0, 2] += nW/2-cx
    M[1, 2] += nH/2-cy
    bg = cv2.warpAffine(bg, M, (nW, nH), borderValue=(32, 34, 38))
    mask = cv2.warpAffine(mask, M, (nW, nH), flags=cv2.INTER_NEAREST)
    x, y, w, h = cv2.boundingRect(largest_contour(mask))
    pad = int(12*px)
    x0, y0 = max(0, x-pad), max(0, y-pad)
    x1, y1 = min(nW, x+w+pad), min(nH, y+h+pad)
    bg = bg[y0:y1, x0:x1]
    mask = mask[y0:y1, x0:x1]
    P = spline(largest_contour(mask).reshape(-1, 2).astype(float), 2.0) / px
    cw, ch = bg.shape[1]/px, bg.shape[0]/px
    P = P - [cw/2, ch/2]
    up2sheet = UprightToSheet(cv2.invertAffineTransform(M), cw, ch, x0, y0, tuple(origin), px)
    ok, buf = cv2.imencode(".png", bg)
    return TraceAssets(buf.tobytes(), P, cw, ch, up2sheet)


def preset_paths(tool, presets_dir=PRESETS_DIR):
    """(photo, rectified image, mask) paths of a built-in preset."""
    return tuple(os.path.join(presets_dir, f"{tool}{suffix}") for suffix in (".jpg", "_rect.png", "_mask.png"))


def load_preset(tool, presets_dir=PRESETS_DIR):
    """Trace assets of a built-in preset from its stored rectified image and mask
    (rectified over ``PRESET_REGIONS[tool]``, else ``REGION``, at ``PX`` px/mm)."""
    _, rect, mask = preset_paths(tool, presets_dir)
    bg = cv2.imread(rect)
    m = cv2.imread(mask, cv2.IMREAD_GRAYSCALE)
    return build_assets(bg, m, origin=PRESET_REGIONS.get(tool, REGION)[:2])


def decode_image(raw):
    """Decode uploaded bytes to a BGR image. OpenCV handles JPEG/PNG/etc.; HEIC/HEIF
    (iPhone photos) is decoded with the optional ``pillow-heif`` package when it is
    installed. Returns None for bytes that are not an image; raises ValueError for
    HEIC/HEIF when ``pillow-heif`` is missing."""
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is not None:
        return img
    if not _is_heif(raw):
        return None
    try:
        import pillow_heif
    except ImportError:
        raise ValueError("HEIC/HEIF photos need the optional pillow-heif package "
                         "(pip install pillow-heif), or convert the photo to JPEG first.") from None
    from PIL import Image
    pillow_heif.register_heif_opener()
    with Image.open(io.BytesIO(raw)) as im:
        rgb = np.asarray(im.convert("RGB"))
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def _is_heif(raw):
    """True for ISO-BMFF HEIC/HEIF/AVIF bytes (an ``ftyp`` box with a HEIF brand)."""
    return len(raw) >= 12 and raw[4:8] == b"ftyp" and raw[8:12] in (
        b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1", b"avif")


def process_photo(img, meta=META, segment=rembg_mask, px=PX):
    """Calibration-sheet photo -> exact-mm tool outline. The tool may be larger
    than the grid and may extend off the paper, as long as all 4 markers are
    visible and the whole tool is in the photo. Raises ValueError otherwise.
    ``segment`` maps a BGR image to a 0-255 mask (rembg by default)."""
    found = detect_markers(img, meta)
    missing = missing_markers(found, meta)
    H = None if missing else homography_img2mm(found, meta)
    if H is None:
        n = len(meta["markers"])
        raise ValueError(f"No calibration sheet detected (found {n-len(missing)} of {n} markers; "
                         f"missing {', '.join(map(str, missing)) or 'none'}). "
                         "Photograph the tool on the printed calibration sheet with all four corner markers "
                         "visible and not covered by the tool.")
    pw, ph = page_mm(meta)
    # pass 1: whole page + 40 mm margin, to find the tool wherever it is
    R1 = (-40, -40, pw+40, ph+40)
    can, valid = rect_region(img, H, R1, meta, px)
    m = segment(can)
    if (m > 128).sum() < (8*px)**2:
        raise ValueError("Calibration sheet found, but no tool was detected on it.")
    c = largest_contour(m)
    x, y, w, h = cv2.boundingRect(c)
    bx0, by0 = R1[0]+x/px, R1[1]+y/px
    bx1, by1 = bx0+w/px, by0+h/px
    # pass 2: tight crop around the tool at full resolution (precise edges)
    R2 = (bx0-15, by0-15, bx1+15, by1+15)
    canvas, valid = rect_region(img, H, R2, meta, px)
    mask = segment(canvas)
    if (mask > 128).sum() < (8*px)**2:
        raise ValueError("Calibration sheet found, but no tool was detected on it.")
    tool = np.zeros_like(mask)
    cv2.drawContours(tool, [largest_contour(mask)], -1, 255, -1)
    edge = cv2.dilate(tool, np.ones((7, 7), np.uint8)) & cv2.bitwise_not(valid)
    if edge.any() or tool[0].any() or tool[-1].any() or tool[:, 0].any() or tool[:, -1].any():
        raise ValueError("Part of the tool is outside the photo. "
                         "Step back so the whole tool and all four markers are in frame.")
    return build_assets(canvas, mask, origin=R2[:2], px=px)
