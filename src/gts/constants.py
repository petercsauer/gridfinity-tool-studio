"""Shared constants and repository paths."""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ASSETS = os.path.join(ROOT, "assets")
SHEET_DIR = os.path.join(ASSETS, "sheet")          # calibration-sheet PDFs, preview, marker metadata
PRESETS_DIR = os.path.join(ASSETS, "presets")      # demo photos plus their rectified image and mask
SHEET_META = os.path.join(SHEET_DIR, "sheet_markers.json")

PX = 8.0                                   # px per mm in rectified images
SCALE = PX                                 # same, as used by the sheet rectifier
SHEET_PX = 4.0                             # px per mm for the on-paper trace image
REGION = (14, 56, 201, 226)                # mm x0,y0,x1,y1 working area (excludes markers/rulers)

# the demo tools the web app ships (build_presets.py)
TOOLS = {"groovejoint": "Groove-joint pliers", "studfinder": "Stud finder"}
# the tools the parity fixtures are made from (make_fixtures.py); their photos stay in assets/presets/
FIXTURE_TOOLS = {"needlenose": "Needle-nose", "combopliers": "Combo pliers",
                 "flushcutter": "Flush cutter", "stripper": "Wire stripper"}
SYM_DEFAULT = {"needlenose": True, "combopliers": True, "flushcutter": True, "stripper": False,
               "groovejoint": False, "studfinder": True}
# presets rectified over the whole page (x0, y0, x1, y1 in mm) instead of REGION, for tools that
# run past the grid
PAGE_REGION = (0.0, 0.0, 215.9, 279.4)
PRESET_REGIONS = {"groovejoint": PAGE_REGION, "studfinder": PAGE_REGION}

# ---- gridfinity constants (kennetek standard.scad) ----
GRID = 42.0
GAP = 0.5
UHT = 7.0
R_TOP = 3.75
PAD_TOP = 41.5
R_BOT = 0.8
PAD_BOTH = 35.6
PAD_MID = 37.2
R_MID = 1.6
LIP_INSET = 1.8 + 1.4                      # stacking-lip trough: rim + lead-in, inset from the outer wall
MIN_WALL = 1.2                             # minimum wall left between the pocket opening and the lip trough
RECESS = 4.4                               # the pocket opens this far below the bin top (lip trough floor)
FLOOR_MIN = 4.75 + 0.8                     # lowest pocket floor: top of the feet plus a 0.8 mm floor
