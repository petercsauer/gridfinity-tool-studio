// Parts the background-removal model can miss. IS-Net looks for the salient object, and on a sheet with a
// large part it can drop a small one (an antenna beside its analyser) altogether. The sheet itself is plain:
// white paper with thin printed lines and text (none over 1 mm wide) and its markers whited out. So whatever
// on the paper is much darker than the paper around it, or strongly coloured, and wider than the print is a
// candidate part; the upload then segments each one the model didn't find in its own crop.
import type { Box, RGBAImage } from './sheet';
import { getCv, type CV } from './opencv';

/** Working scale (px per mm). */
const S = 2;
/** The paper (sheet mm) that candidates are looked for on: Letter and A4 both cover it, less a 3 mm margin. */
const PAPER: Box = [3, 3, 207.9, 276.4];
/** A pixel is a candidate when darker than this share of the paper brightness around it… */
const DARK = 0.62;
/** …or this saturated (0-255) and darker than this share of the paper: saturation alone also fires on plain
 * paper in a photo with a colour cast (warm light), which leaves a pixel's saturation but not its brightness. */
const SATURATED = 90;
const TINTED = 0.85;
/** Width (mm) of the brightness estimate's window: the paper level is found across features narrower than it. */
const PAPER_WINDOW = 26;
/** Width (mm) of the opening that removes the print (lines and text) and specks. */
const PRINT = 2.5;
/** Smallest candidate, mm². */
const MIN_AREA = 64;

export interface Blob {
  /** Bounding box in sheet mm. */
  box: Box;
  /** The point deepest inside the blob (sheet mm): on the part, wherever its box's centre falls (between a
   * pliers' handles, say). */
  inner: [number, number];
}

/** The dark or coloured blobs on the paper in `canvas`, a rectified region at `pxPerMm` whose pixel (0, 0) sits
 * at `origin` on the sheet. */
export async function paperBlobs(canvas: RGBAImage, origin: readonly [number, number], pxPerMm: number): Promise<Blob[]> {
  const cv: CV = await getCv();
  const own: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(x: T) => (own.push(x), x);
  try {
    const src = keep(cv.matFromArray(canvas.height, canvas.width, cv.CV_8UC4, canvas.data));
    const w = Math.max(1, Math.round((canvas.width * S) / pxPerMm));
    const h = Math.max(1, Math.round((canvas.height * S) / pxPerMm));
    const small = keep(new cv.Mat());
    cv.resize(src, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    const gray = keep(new cv.Mat());
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    const rgb = keep(new cv.Mat());
    cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
    const hsv = keep(new cv.Mat());
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    // the paper's brightness around each pixel: a closing removes everything darker and narrower than the window
    const bg = keep(new cv.Mat());
    const win = Math.round(PAPER_WINDOW * S) | 1;
    const big = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(win, win)));
    cv.morphologyEx(gray, bg, cv.MORPH_CLOSE, big);

    const g = gray.data as Uint8Array, b = bg.data as Uint8Array, hs = hsv.data as Uint8Array;
    const mask = keep(cv.Mat.zeros(h, w, cv.CV_8UC1));
    const m = mask.data as Uint8Array;
    const x0 = Math.max(0, Math.floor((PAPER[0] - origin[0]) * S)), x1 = Math.min(w, Math.ceil((PAPER[2] - origin[0]) * S));
    const y0 = Math.max(0, Math.floor((PAPER[1] - origin[1]) * S)), y1 = Math.min(h, Math.ceil((PAPER[3] - origin[1]) * S));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        const paper = b[i]!;
        if (paper < 100) continue; // not paper: off the photo, or a dark table
        if (g[i]! < DARK * paper || (hs[i * 3 + 1]! > SATURATED && g[i]! < TINTED * paper)) m[i] = 255;
      }
    }
    // drop the print and specks, then rejoin a part's pieces
    const k = Math.round(PRINT * S) | 1;
    const el = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, el);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, el);

    const labels = keep(new cv.Mat());
    const stats = keep(new cv.Mat());
    const centroids = keep(new cv.Mat());
    const n = cv.connectedComponentsWithStats(mask, labels, stats, centroids, 8, cv.CV_32S);
    const st = stats.data32S as Int32Array;
    // each blob's deepest pixel
    const dist = keep(new cv.Mat());
    cv.distanceTransform(mask, dist, cv.DIST_L2, 3);
    const lab = labels.data32S as Int32Array, dd = dist.data32F as Float32Array;
    const deepest = new Int32Array(n).fill(-1);
    for (let i = 0; i < lab.length; i++) {
      const l = lab[i]!;
      if (l > 0 && (deepest[l]! < 0 || dd[i]! > dd[deepest[l]!]!)) deepest[l] = i;
    }
    const out: Blob[] = [];
    for (let i = 1; i < n; i++) {
      const [bx, by, bw, bh, area] = [st[i * 5]!, st[i * 5 + 1]!, st[i * 5 + 2]!, st[i * 5 + 3]!, st[i * 5 + 4]!];
      if (area < MIN_AREA * S * S) continue;
      const d = deepest[i]!;
      out.push({
        box: [origin[0] + bx / S, origin[1] + by / S, origin[0] + (bx + bw) / S, origin[1] + (by + bh) / S],
        inner: [origin[0] + ((d % w) + 0.5) / S, origin[1] + (Math.floor(d / w) + 0.5) / S],
      });
    }
    return out;
  } finally {
    for (const x of own) x.delete();
  }
}
