# Gridfinity Tool Studio

Turn a phone photo of a hand tool into a 3D‑printable [gridfinity](https://gridfinity.xyz) bin with a tool‑shaped pocket.

![Gridfinity Tool Studio](docs/screenshot.png)

1. **Print** the calibration sheet (Letter or A4) at 100 % / Actual Size.
2. **Photograph** the tool lying flat on it, from straight above, flash on.
3. **Tune** the pocket, finger slot, bin height, depth and edge rounding, and watch the bin update in 3D.
4. **Export STL** and print.

The four corner markers on the sheet give exact real‑world scale and remove perspective, so the pocket is
measured in millimetres, not guessed. The tool is cut out of the photo with an AI background‑removal model,
which handles shiny metal and black handles that simple thresholding misses.

## Quick start

```sh
python3 -m pip install -r requirements.txt     # Python 3.11+
python3 webapp/app.py                          # → http://localhost:8765
```

The first photo upload downloads the background‑removal model (~170 MB) and takes about 10 s; later uploads
are faster. Everything runs locally; photos never leave your machine.

## Taking a good photo

- Print the sheet at **100 % / Actual Size** (no "fit to page"). Check the 100 mm bar with a ruler.
- Lay the tool flat. **It's fine if it's bigger than the grid** or hangs off the paper, as long as it doesn't
  cover a corner marker and is fully in the photo.
- Hold the camera **level**, straight above the sheet, with the **flash on**.
- **iPhone:** Settings › Camera › **Grid** on, then line up the two crosshairs in the Camera app before shooting.
- Keep all **4 corner markers** visible. Photos without the sheet are rejected.

JPEG, PNG and HEIC (iPhone) photos all work.

## What you can tune

| Setting | What it does |
|---|---|
| Symmetric tool | Mirror‑averages the outline about the tool's own axis for a clean, even cutout |
| Clearance | Gap between the tool and the pocket wall |
| Rotation | Rotates the cutout inside the bin |
| Finger slot | A rounded grab slot across the tool: diameter and position along its length |
| Height | Bin height in gridfinity units (7 mm each) |
| Depth | How deep the tool pocket is |
| Top fillet | Rounded lead‑in at the pocket opening |
| Bottom round | Rounds the pocket floor into the walls |

Bins use the standard gridfinity 42 mm grid, base profile and stacking lip, and the footprint grows in whole
cells to fit the pocket. The 3D preview keeps your camera angle between rebuilds; double‑click it to re‑frame.

## How it works

`webapp/app.py` is a small Python server; `webapp/index.html` is the whole UI (Three.js for the 3D preview).
The pipeline itself is the `gts` package in `src/gts/` (`sheet`, `trace`, `geometry`, `bin`).

1. **Sheet:** ArUco markers (`cv2.aruco`, 4×4 dictionary) → homography to sheet millimetres
   (`src/gts/sheet.py`).
2. **Cut‑out:** [rembg](https://github.com/danielgatis/rembg) IS‑Net on the perspective‑corrected page, then
   again on a tight crop around the tool for precise edges.
3. **Outline:** largest contour → smoothing spline → straightened to the tool's long axis.
4. **Pocket:** shapely offset for clearance, plus a stadium‑shaped finger slot.
5. **Bin:** [manifold3d](https://github.com/elalish/manifold) builds the gridfinity feet, body and stacking lip,
   and subtracts the pocket with stepped round‑overs, so the STL is always watertight.

## Other tools in this repo

| Path | Purpose |
|---|---|
| `src/gts/` | The reference pipeline as a package: sheet detection, tracing, pocket geometry, bin |
| `src/sheetgen.py` | Regenerates the calibration sheet PDFs and marker metadata in `assets/sheet/`: `python3 src/sheetgen.py letter` or `a4` |
| `src/analyze_rembg.py` | Command‑line version of the trace pipeline for a single photo |
| `src/gridfinity_bin.py`, `src/holder.py`, `src/pack.py` | Command‑line bin, pocket and multi‑tool layout generators |
| `src/gf_build_all.py`, `src/gridfinity.fs.tmpl`, `src/onshape.py` | Builds the bins as a parametric Onshape FeatureScript feature (needs an Onshape API key in `~/.onshape_key`) |
| `docs/design-spec.md` | Design spec for the UI |
| `assets/presets/` | The four built‑in demo tools: photo (`<tool>.jpg`), rectified image (`<tool>_rect.png`) and mask (`<tool>_mask.png`) |
| `assets/sheet/` | Calibration sheet PDFs, preview and `sheet_markers.json` (marker positions in mm) |
| `tests/python/` | Tests: `python3 -m pytest -q` |

The command‑line tools write their generated files to `out/`, which is not tracked.

## License

MIT — see LICENSE. Third-party notices, including the AI model weights caveat, are in NOTICE.
