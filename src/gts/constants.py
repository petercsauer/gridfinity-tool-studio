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

TOOLS = {"needlenose": "Needle-nose", "combopliers": "Combo pliers",
         "flushcutter": "Flush cutter", "stripper": "Wire stripper"}
SYM_DEFAULT = {"needlenose": True, "combopliers": True, "flushcutter": True, "stripper": False}

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
