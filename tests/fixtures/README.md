# Parity fixtures

Reference outputs of the Python pipeline (`src/gts`) that the browser port is
tested against. Regenerate them after any change to the reference:

```
python3 -I scripts/make_fixtures.py && git status --short tests/fixtures
```

The script is deterministic, so a second run gives no diff. Every float is
rounded to 4 decimals, except `homography`, which is rounded to 10 significant
digits because its perspective terms are around 1e-6. Units are mm unless a
field name ends in `_px`. Image y points down; outlines are in the same frame.

## `presets/<tool>.json`

One file per built-in preset (`needlenose`, `combopliers`, `flushcutter`,
`stripper`).

| Field | Meaning |
|---|---|
| `tool` | Preset id. |
| `marker_corners_px` | Calibration-marker id (`"0"`..`"3"`) to its 4 corners in pixels of `assets/presets/<tool>.jpg`, in ArUco order (top-left, top-right, bottom-right, bottom-left of the marker). |
| `homography` | 3x3 matrix mapping photo pixels to sheet mm (`gts.sheet.homography_img2mm`, all 16 corners, RANSAC). |
| `outline_mm` | The tool's upright, centred outline: 720 points of a periodic smoothing spline, from the stored preset mask (`gts.trace.load_preset`). The crop centre is the origin. |
| `crop_mm` | `[w, h]` of the upright crop the outline is centred in. |
| `up2sheet` | 2x3 affine `[A | b]` from upright-centred outline mm to sheet mm: `sheet = A @ q + b`. The Python transform is exactly affine (checked to 1e-6 when the fixture is written). |
| `symmetric_outline_mm` | `gts.geometry.symmetrize(outline_mm).outline`: 720 points with positive shoelace area, in the same upright frame as `outline_mm`. It is the union of the outline and its reflection about the best mirror axis, closed with a 1 mm round offset, and contains the original outline. |
| `symmetry_score` | Mirror IoU of `outline_mm` with its reflection about that axis. The UI warns below 0.92. |
| `symmetry_axis` | The mirror axis: `deg` from the y axis, through `centre_mm` (the outline's area centroid) shifted by `offset_mm` along the rotated x axis, that is through `centre + offset * (cos deg, sin deg)` with direction `(-sin deg, cos deg)`. |
| `params` | The default parameters used for `pocket_mm`, `footprint` and `bin` (the web app's names). `sym` says whether the symmetric outline was used. |
| `pocket_mm` | Exterior ring of the pocket polygon (`gts.geometry.make_pocket`: clearance offset with round joins, plus the stadium finger slot), in the outline frame, not centred. |
| `footprint` | `[nx, ny]` grid cells from `gts.geometry.footprint(pocket_mm, fillet)`: per axis `ceil((extent + 2*fillet + 2*(3.2 + 1.2) + 0.5) / 42)`. |
| `bin` | The generated bin for `params` (`gts.bin.genbin`, with the pocket centred on its bounding-box centre): `bbox` `[[xmin, ymin, zmin], [xmax, ymax, zmax]]`, `volume_mm3`, and `effective_depth` (the pocket depth actually cut, at most `u*7 - 4.4 - 5.55`). |

## `masks/<tool>.json`

Statistics of the stored rectified-canvas mask for each preset, for the
outline (S4b) and segmentation (S4c) parity tests.

| Field | Meaning |
|---|---|
| `mask_png`, `rect_png` | Repo-relative paths of the 0-255 mask and the rectified photo it was made from. |
| `region_mm` | Sheet-mm region `[x0, y0, x1, y1]` the canvas covers. |
| `origin_mm` | Sheet-mm position of canvas pixel (0, 0). |
| `px_per_mm` | Canvas scale. |
| `size_px` | `[width, height]` of the mask. |
| `foreground_px` | Number of mask pixels above 128. |
| `largest_contour_area_px` | `cv2.contourArea` of the largest external contour. |
| `bbox_px` | `cv2.boundingRect` of that contour, `[x, y, w, h]`. |
| `min_area_rect_px` | `cv2.minAreaRect` of that contour (OpenCV 5 angle convention). |
