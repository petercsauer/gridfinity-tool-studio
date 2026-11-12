"""Gridfinity Tool Studio reference pipeline.

Pure functions that turn a photo of a tool on the calibration sheet into a
tool-shaped gridfinity bin:

- ``gts.sheet``: calibration-sheet markers, homography and rectification.
- ``gts.trace``: image decoding, background removal and the upright outline.
- ``gts.geometry``: outline smoothing, rotation, symmetry and the pocket.
- ``gts.bin``: the watertight gridfinity bin (manifold3d).
"""
