#!/usr/bin/env python3
"""Make a simple test-print block with one tool pocket cut into the top.
  block height = 0.5 in (12.7 mm), floor under the pocket = 0.1 in (2.54 mm).
Run with -I:  python3 stl_block.py flushcutter [--margin 4] [--out <path>]
"""
import sys, os, numpy as np, trimesh
from manifold3d import Manifold, CrossSection, FillRule

OUT=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),"out")
IN=25.4; H=0.5*IN; FLOOR=0.1*IN; MARGIN=4.0

def ccw(p):
    a=np.sum(p[:,0]*np.roll(p[:,1],-1)-np.roll(p[:,0],-1)*p[:,1])
    return p if a>0 else p[::-1]

def main():
    a=sys.argv[1:]; name=a[0] if a and not a[0].startswith("--") else "flushcutter"
    def opt(f,d):
        if f in a: i=a.index(f); v=a[i+1]; del a[i:i+2]; return v
        return d
    margin=float(opt("--margin",MARGIN)); outp=opt("--out",os.path.join(OUT,f"{name}_testblock.stl"))
    pk=ccw(np.load(os.path.join(OUT,f"{name}_pocket.npy")))     # mm, min0
    w,h=pk[:,0].max(),pk[:,1].max()
    rect=np.array([[-margin,-margin],[w+margin,-margin],[w+margin,h+margin],[-margin,h+margin]])
    block=CrossSection([rect.tolist()],FillRule.Positive).extrude(H)
    pocket=CrossSection([pk.tolist()],FillRule.Positive).extrude(H-FLOOR+1).translate([0,0,FLOOR])
    solid=block-pocket
    m=solid.to_mesh()
    tm=trimesh.Trimesh(vertices=np.asarray(m.vert_properties)[:,:3],faces=np.asarray(m.tri_verts))
    tm.export(outp)
    bw,bh=w+2*margin,h+2*margin
    print(f"{name} test block -> {outp}")
    print(f"  block {bw:.1f} x {bh:.1f} x {H:.2f} mm  (floor {FLOOR:.2f} mm, pocket depth {H-FLOOR:.2f} mm)")
    print(f"  watertight={tm.is_watertight}  volume={tm.volume/1000:.1f} cm^3")

if __name__=="__main__": main()
