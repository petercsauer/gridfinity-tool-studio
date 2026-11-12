#!/usr/bin/env python3
"""Generate a spec-compliant gridfinity bin (per-cell feet + body + stacking
lip) with a tool pocket cut into the top. Pure manifold3d -> watertight STL.
Dims from kennetek standard.scad. Run with -I:
  python3 gridfinity_bin.py flushcutter [--u 3] [--floor 2.25] [--out path]
"""
import sys, os, numpy as np, trimesh
from manifold3d import Manifold, CrossSection, JoinType, FillRule

OUT=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),"out")
GRID=42.0; GAP=0.5; U=7.0
# base pad profile (bottom->top): 0.8 @45, 1.8 straight, 2.15 @45 ; total 4.75
PAD_TOP=41.5; R_TOP=3.75; R_BOT=0.8          # per-cell foot
PAD_BOTH=PAD_TOP-2*(2.15+0.8)                # bottom square = 35.6
PAD_MID=PAD_TOP-2*2.15                        # mid square   = 37.2
R_MID=R_TOP-2.15                              # = 1.6

def ccw(p):
    a=np.sum(p[:,0]*np.roll(p[:,1],-1)-np.roll(p[:,0],-1)*p[:,1])
    return p if a>0 else p[::-1]

def rrect(w,h,r):
    r=max(0.2,min(r,w/2-0.05,h/2-0.05))
    c=CrossSection([[[-w/2+r,-h/2+r],[w/2-r,-h/2+r],[w/2-r,h/2-r],[-w/2+r,h/2-r]]],FillRule.Positive)
    return c.offset(r,JoinType.Round,2.0,64)

def slab(cs,z0,z1): return cs.extrude(z1-z0).translate([0,0,z0])
def frustum(a,ra,z0,b,rb,z1):               # square a@z0 -> square b@z1, tapered
    return (slab(rrect(a,a,ra),z0,z0+0.02)+slab(rrect(b,b,rb),z1-0.02,z1)).hull()

def foot():
    b1=frustum(PAD_BOTH,R_BOT,0.0, PAD_MID,R_MID,0.8)
    mid=slab(rrect(PAD_MID,PAD_MID,R_MID),0.8,2.6)
    b3=frustum(PAD_MID,R_MID,2.6, PAD_TOP,R_TOP,4.75)
    return b1+mid+b3

def main():
    a=sys.argv[1:]; name=a[0] if a and not a[0].startswith("--") else "flushcutter"
    def opt(f,d):
        if f in a: i=a.index(f); v=a[i+1]; del a[i:i+2]; return v
        return d
    u=int(opt("--u",3)); floor=float(opt("--floor",2.25))
    outp=opt("--out",os.path.join(OUT,f"{name}_bin.stl"))
    pk=ccw(np.load(os.path.join(OUT,f"{name}_pocket.npy")))
    pw,ph=pk[:,0].max(),pk[:,1].max()
    nx=int(np.ceil(pw/GRID)); ny=int(np.ceil(ph/GRID))
    Dx,Dy=GRID*nx-GAP,GRID*ny-GAP; Htop=u*U

    feet=Manifold()
    for i in range(nx):
        for j in range(ny):
            cx=(i+0.5)*GRID-GRID*nx/2; cy=(j+0.5)*GRID-GRID*ny/2
            feet+=foot().translate([cx,cy,0])
    body=slab(rrect(Dx,Dy,R_TOP),4.75,Htop)

    # stacking lip: recess cut around the top perimeter (rim wall ~1.8 mm)
    rim=1.8; rw,rh,rr=Dx-2*rim,Dy-2*rim,max(0.3,R_TOP-rim)
    main_r=slab(rrect(rw,rh,rr),Htop-3.0,Htop+1.0)
    lead=(slab(rrect(rw-2.8,rh-2.8,max(0.2,rr-1.4)),Htop-4.4,Htop-4.38)
          +slab(rrect(rw,rh,rr),Htop-3.02,Htop-3.0)).hull()
    lip_cut=main_r+lead

    # tool pocket, centered, cut from floor to top
    pc=ccw(pk-[pw/2,ph/2])
    pocket=slab(CrossSection([pc.tolist()],FillRule.NonZero),Htop-(Htop-floor-4.75),Htop+1.0)
    # pocket spans from floor level (above feet+floor) to top
    floor_top=4.75+floor
    pocket=slab(CrossSection([pc.tolist()],FillRule.NonZero),floor_top,Htop+1.0)

    binm=(feet+body)-lip_cut-pocket
    m=binm.to_mesh()
    V=np.asarray(m.vert_properties)[:,:3]; F=np.asarray(m.tri_verts)
    tm=trimesh.Trimesh(vertices=V,faces=F)
    tm.export(outp)
    print(f"{name} bin -> {outp}")
    print(f"  footprint {nx}x{ny} cells = {Dx:.1f} x {Dy:.1f} mm, height {u}U = {Htop:.1f} mm")
    print(f"  floor {floor:.2f} mm over feet -> pocket depth {Htop-floor_top:.2f} mm")
    print(f"  watertight={tm.is_watertight}  volume={tm.volume/1000:.1f} cm^3")

if __name__=="__main__": main()
