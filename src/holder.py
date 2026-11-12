#!/usr/bin/env python3
"""Pocket layout per tool: 1.5 mm clearance ring + a 25 mm finger slot cut
across, over a crop of the real (rectified) photo so the fit is eyeballable.
Symmetric tools are mirror-averaged about their long axis first. Rebuilds base
outline svg/dxf/npy + pocket svg + preview PNG (in out/) from the preset
rectified frames and rembg mattes in assets/presets/. Run with -I.
  photo crop (bg)   blue = tool outline   red = clearance ring + finger slot
"""
import os, sys, numpy as np, cv2
from scipy.ndimage import distance_transform_edt
from shapely.geometry import Polygon, LineString
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import analyze_sheet as A
from gts.trace import preset_paths

OUT=A.OUT; PX=A.SCALE                      # 8 px/mm
TOOLS=["needlenose","combopliers","flushcutter","stripper"]
TITLE={"needlenose":"Needle-nose","combopliers":"Combo pliers",
       "flushcutter":"Flush cutter","stripper":"Wire stripper"}
SYM={"needlenose":True,"combopliers":True,"flushcutter":True,"stripper":False}
CLEAR=2.5; FINGER_R=12.5; FINGER_OVER=6.0  # mm
FRAC={"needlenose":0.43,"combopliers":0.39,"flushcutter":0.34,"stripper":0.49}

def largest(mask):
    c,_=cv2.findContours((mask>128).astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_NONE)
    return max(c,key=cv2.contourArea)

def upright(bg,mask):
    """Rotate bg+mask so the tool's long axis is vertical; crop to tool+pad."""
    c=largest(mask); (cx,cy),(w,h),ang=cv2.minAreaRect(c.astype(np.float32))
    if w>h: ang+=90
    H0,W0=mask.shape; M=cv2.getRotationMatrix2D((cx,cy),ang,1.0)
    cos,sin=abs(M[0,0]),abs(M[0,1]); nW=int(H0*sin+W0*cos); nH=int(H0*cos+W0*sin)
    M[0,2]+=nW/2-cx; M[1,2]+=nH/2-cy
    bg=cv2.warpAffine(bg,M,(nW,nH),borderValue=(235,235,235))
    mask=cv2.warpAffine(mask,M,(nW,nH),flags=cv2.INTER_NEAREST)
    x,y,w,h=cv2.boundingRect(largest(mask)); pad=int(10*PX)
    x0,y0=max(0,x-pad),max(0,y-pad); x1,y1=min(nW,x+w+pad),min(nH,y+h+pad)
    return bg[y0:y1,x0:x1], mask[y0:y1,x0:x1]

def symmetrize_px(mask):
    """Mirror-average the matte about its vertical centroid axis (removes
    one-sided capture noise) and return the cleaned filled mask, same frame."""
    m=(mask>128).astype(np.uint8)
    mo=cv2.moments(m,binaryImage=True); cx=mo["m10"]/mo["m00"]
    mir=cv2.warpAffine(m,np.float32([[-1,0,2*cx],[0,1,0]]),m.shape[::-1],flags=cv2.INTER_NEAREST)
    sdf=lambda a: distance_transform_edt(1-a)-distance_transform_edt(a)
    return (((sdf(m)+sdf(mir))/2)<=0).astype(np.uint8)*255

def outline_px(mask):
    return A.spline(largest(mask).reshape(-1,2).astype(float),2.0)

def ring_pill(P,clear,r,over,frac):
    tool=Polygon(P).buffer(0); clr=tool.buffer(clear,join_style=1,quad_segs=16)
    yy=P[:,1].min()+frac*(P[:,1].max()-P[:,1].min())
    row=clr.intersection(LineString([(P[:,0].min()-9e3,yy),(P[:,0].max()+9e3,yy)]))
    xs=np.array(row.coords) if row.geom_type=="LineString" else np.vstack([np.array(g.coords) for g in row.geoms])
    pill=LineString([(xs[:,0].min()-over,yy),(xs[:,0].max()+over,yy)]).buffer(r,cap_style=1,quad_segs=16)
    return tool, clr.union(pill)

xy=lambda g: np.array(g.exterior.coords)

fig,axes=plt.subplots(1,4,figsize=(16,7.5))
for ax,name in zip(axes,TOOLS):
    _,rect_png,mask_png=preset_paths(name)
    bg=cv2.imread(rect_png)
    mask=cv2.imread(mask_png,cv2.IMREAD_GRAYSCALE)
    bg,mask=upright(bg,mask)
    if SYM[name]: mask=symmetrize_px(mask)
    P=outline_px(mask)                                  # px, upright crop frame
    tool,pocket=ring_pill(P,CLEAR*PX,FINGER_R*PX,FINGER_OVER*PX,FRAC[name])
    A.export(name, P/PX)                                # base svg/dxf/npy (mm)
    pc=xy(pocket); tc=xy(tool); mn=pc.min(0)            # pocket svg (mm)
    pcs=(pc-mn)/PX; tcs=(tc-mn)/PX; w,h=pcs[:,0].max(),pcs[:,1].max()
    np.save(os.path.join(OUT,f"{name}_pocket.npy"),pcs)
    np.save(os.path.join(OUT,f"{name}_toolref.npy"),tcs)
    dp="M "+" L ".join(f"{a:.2f},{b:.2f}" for a,b in pcs)+" Z"
    dt="M "+" L ".join(f"{a:.2f},{b:.2f}" for a,b in tcs)+" Z"
    open(os.path.join(OUT,f"{name}_pocket.svg"),"w",encoding="utf-8").write(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.2f}mm" height="{h:.2f}mm" '
        f'viewBox="-2 -2 {w+4:.2f} {h+4:.2f}">'
        f'<path d="{dp}" fill="#fde0e0" stroke="#d81f1f" stroke-width="0.5"/>'
        f'<path d="{dt}" fill="none" stroke="#1f4e79" stroke-width="0.4"/></svg>')
    # preview: photo crop behind, pocket + outline over it
    ax.imshow(cv2.cvtColor(bg,cv2.COLOR_BGR2RGB))
    ax.fill(pc[:,0],pc[:,1],facecolor="#d81f1f",alpha=0.22,zorder=1)
    ax.plot(pc[:,0],pc[:,1],color="#d81f1f",lw=2,zorder=3)
    ax.plot(tc[:,0],tc[:,1],color="#2f6fd0",lw=1.6,zorder=4)
    ax.set_title(f"{TITLE[name]}{' (sym)' if SYM[name] else ''}\npocket {w:.0f} x {h:.0f} mm",fontsize=11)
    ax.set_xlim(0,bg.shape[1]); ax.set_ylim(bg.shape[0],0); ax.set_aspect("equal"); ax.axis("off")
    print(f"{name}: pocket {w:.1f} x {h:.1f} mm{'  [sym]' if SYM[name] else ''}")
fig.suptitle(f"Tool pockets over photo — {CLEAR} mm clearance + {2*FINGER_R:.0f} mm finger slot",fontsize=13)
fig.tight_layout(); fig.savefig(os.path.join(OUT,"pockets_preview.png"),dpi=130,bbox_inches="tight")
print("wrote out/pockets_preview.png")
