#!/usr/bin/env python3
"""Analyze a photo of a tool on the calibration sheet.
Detect ArUco markers -> homography to real mm -> rectify -> segment tool ->
spline-smoothed outline -> exact-scale SVG + DXF + overlay.

Run: python3 analyze_sheet.py photo.jpg [--name NAME] [--all] [--s 2.0]
     [--rectify-only]  (just dump the perspective-corrected sheet)
"""
import sys, os, json, numpy as np, cv2
from scipy.interpolate import splprep, splev

OUT=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),"out")
META=json.load(open(os.path.join(OUT,"sheet_markers.json")))
SCALE=8.0                       # px per mm in the rectified canvas
REGION=(14,56,201,226)          # mm x0,y0,x1,y1 working area (excludes markers/rulers)

def detect_markers(img):
    d=cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco,META["dict"]))
    det=cv2.aruco.ArucoDetector(d, cv2.aruco.DetectorParameters())
    corners,ids,_=det.detectMarkers(img)
    found={}
    if ids is not None:
        for c,i in zip(corners,ids.flatten()):
            found[int(i)]=c.reshape(4,2)
    return found

def homography_img2mm(found):
    src=[]; dst=[]
    for mid,cmm in META["markers"].items():
        mid=int(mid)
        if mid in found:
            src.extend(found[mid]); dst.extend(cmm)
    if len(src)<8: return None
    H,_=cv2.findHomography(np.array(src,np.float32),np.array(dst,np.float32),cv2.RANSAC)
    return H

def rectify(img,H):
    x0,y0,x1,y1=REGION
    A=np.array([[SCALE,0,-x0*SCALE],[0,SCALE,-y0*SCALE],[0,0,1]],np.float64)
    cw=int((x1-x0)*SCALE); ch=int((y1-y0)*SCALE)
    return cv2.warpPerspective(img,A@H,(cw,ch)), (x0,y0)

def tool_mask(canvas, dark=0.96, sat=50, opn=3, cls=41):
    g=cv2.cvtColor(canvas,cv2.COLOR_BGR2GRAY).astype(np.float32)
    s=cv2.cvtColor(canvas,cv2.COLOR_BGR2HSV)[:,:,1]
    # illumination-correct: divide by a heavily blurred version so paper ~1.0
    # everywhere despite lighting falloff. tool = locally darker OR saturated.
    bgest=cv2.GaussianBlur(g,(0,0),60)
    norm=g/(bgest+1.0)
    m=(((norm<dark)|(s>sat))*255).astype(np.uint8)
    if opn>0: m=cv2.morphologyEx(m,cv2.MORPH_OPEN,np.ones((opn|1,opn|1),np.uint8))  # grid/speck
    if cls>0: m=cv2.morphologyEx(m,cv2.MORPH_CLOSE,np.ones((cls|1,cls|1),np.uint8)) # bridge gaps
    cnts,_=cv2.findContours(m,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    if not cnts: return m
    c=max(cnts,key=cv2.contourArea)
    out=np.zeros_like(m); cv2.drawContours(out,[c],-1,255,-1)        # solid tool, holes filled
    return out

def rotate_principal(P):
    """Rotate contour so its long axis is vertical (clean, consistent export)."""
    rect=cv2.minAreaRect(P.astype(np.float32)); (cx,cy),(w,h),ang=rect
    if w>h: ang+=90
    th=np.deg2rad(ang); c,s=np.cos(-th),np.sin(-th)
    R=np.array([[c,-s],[s,c]]); return (P-[cx,cy])@R.T

def spline(C,sf=2.0,n=720):
    seg=np.sqrt((np.diff(np.vstack([C,C[:1]]),axis=0)**2).sum(1))
    s=np.r_[0,np.cumsum(seg)]; u=np.linspace(0,s[-1],n,endpoint=False)
    C=np.c_[np.interp(u,s,np.r_[C[:,0],C[0,0]]),np.interp(u,s,np.r_[C[:,1],C[0,1]])]
    tck,_=splprep([C[:,0],C[:,1]],s=len(C)*sf,per=1); xs,ys=splev(np.linspace(0,1,n),tck)
    return np.c_[xs,ys]

def export(name,P_mm):
    p=P_mm-P_mm.min(0); w,h=p[:,0].max(),p[:,1].max()
    grid="".join(f'<line x1="{g:.1f}" y1="0" x2="{g:.1f}" y2="{h:.1f}" stroke="#ccc" stroke-width="0.2"/>' for g in np.arange(0,w,10))
    grid+="".join(f'<line x1="0" y1="{g:.1f}" x2="{w:.1f}" y2="{g:.1f}" stroke="#ccc" stroke-width="0.2"/>' for g in np.arange(0,h,10))
    d="M "+" L ".join(f"{a:.2f},{b:.2f}" for a,b in p)+" Z"
    open(os.path.join(OUT,f"{name}.svg"),"w").write(f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.2f}mm" height="{h:.2f}mm" viewBox="-2 -2 {w+4:.2f} {h+4:.2f}"><g>{grid}</g><path d="{d}" fill="#d9e6f2" fill-opacity="0.85" stroke="#1f4e79" stroke-width="0.5"/></svg>')
    os.makedirs(os.path.join(OUT,"dxf"),exist_ok=True)
    body=["0","SECTION","2","HEADER","9","$INSUNITS","70","4","0","ENDSEC","0","SECTION","2","ENTITIES","0","POLYLINE","8",name,"66","1","70","1"]
    for x,y in p: body+=["0","VERTEX","8",name,"10",f"{x:.3f}","20",f"{-y:.3f}","30","0.0"]
    body+=["0","SEQEND","8",name,"0","ENDSEC","0","EOF"]
    open(os.path.join(OUT,"dxf",f"{name}.dxf"),"w").write("\n".join(body)+"\n")
    np.save(os.path.join(OUT,f"{name}_sheetpts.npy"),p)
    print(f"{name}: {w:.1f} x {h:.1f} mm  ({w/25.4:.2f} x {h/25.4:.2f} in)")

def main():
    a=sys.argv[1:]
    def opt(f,d,c=str):
        if f in a:
            i=a.index(f); v=c(a[i+1]); del a[i:i+2]; return v
        return d
    name=opt("--name",None); sf=float(opt("--s","2.0"))
    dark=float(opt("--dark","0.96")); satt=int(opt("--sat","50"))
    opn=int(opt("--open","3")); cls=int(opt("--close","41"))
    allb="--all" in a
    if "--all" in a: a.remove("--all")
    reconly="--rectify-only" in a
    if reconly: a.remove("--rectify-only")
    photo=a[0]; img=cv2.imread(photo)
    base=name or os.path.splitext(os.path.basename(photo))[0]
    found=detect_markers(img)
    print("markers found:",sorted(found))
    H=homography_img2mm(found)
    if H is None: print("need >=2 markers (4 best). retake with all corners visible."); return
    canvas,_=rectify(img,H)
    cv2.imwrite(os.path.join(OUT,f"rectified_{base}.png"),canvas)
    if reconly: print("rectified ->",f"out/rectified_{base}.png"); return
    m=tool_mask(canvas,dark,satt,opn,cls)
    cnts,_=cv2.findContours(m,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_NONE)
    cnts=[c for c in cnts if cv2.contourArea(c)>(8*SCALE)**2]
    cnts=sorted(cnts,key=cv2.contourArea,reverse=True)
    if not cnts: print("no tool blob found inside the sheet area"); return
    chosen=cnts if allb else cnts[:1]
    ov=canvas.copy()
    for k,c in enumerate(chosen):
        sm=spline(c.reshape(-1,2).astype(float),sf)         # smooth in canvas px
        cv2.polylines(ov,[sm.astype(np.int32)],True,(121,78,31),2)
        export(base if len(chosen)==1 else f"{base}_{k+1}", rotate_principal(sm)/SCALE)
    cv2.imwrite(os.path.join(OUT,f"sheet_overlay_{base}.png"),ov)
    print("overlay ->",f"out/sheet_overlay_{base}.png")

def touches_border(c,W,H,m=3):
    x,y,w,h=cv2.boundingRect(c); return x<=m or y<=m or x+w>=W-m or y+h>=H-m

if __name__=="__main__": main()
