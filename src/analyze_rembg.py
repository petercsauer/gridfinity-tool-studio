#!/usr/bin/env python3
"""Sheet photo -> ArUco rectify -> rembg (IS-Net/DIS) matte -> largest contour
-> spline -> exact-mm SVG/DXF + overlay. Learned segmentation (no thresholds).
Run: python3 analyze_rembg.py photo.jpg [--name N] [--model isnet-general-use]
     [--thr 128] [--s 2.0]
"""
import sys, os, numpy as np, cv2
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import analyze_sheet as A
from rembg import remove, new_session

def main():
    a=sys.argv[1:]
    def opt(f,d):
        if f in a:
            i=a.index(f); v=a[i+1]; del a[i:i+2]; return v
        return d
    name=opt("--name",None); model=opt("--model","isnet-general-use")
    thr=int(opt("--thr","128")); sf=float(opt("--s","2.0"))
    photo=a[0]; img=cv2.imread(photo)
    base=name or os.path.splitext(os.path.basename(photo))[0]
    H=A.homography_img2mm(A.detect_markers(img))
    if H is None: print("markers not found"); return
    canvas,_=A.rectify(img,H)
    sess=new_session(model)
    rgb=cv2.cvtColor(canvas,cv2.COLOR_BGR2RGB)
    mask=remove(rgb,session=sess,only_mask=True,
                post_process_mask=True)      # single-channel alpha/mask
    mask=np.asarray(mask)
    if mask.ndim==3: mask=mask[:,:,0]
    os.makedirs(A.OUT,exist_ok=True)
    cv2.imwrite(os.path.join(A.OUT,f"rembgmask_{base}.png"),mask)
    m=(mask>thr).astype(np.uint8)*255
    m=cv2.morphologyEx(m,cv2.MORPH_OPEN,np.ones((5,5),np.uint8))
    cnts,_=cv2.findContours(m,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_NONE)
    cnts=[c for c in cnts if cv2.contourArea(c)>(8*A.SCALE)**2]
    if not cnts: print("no tool in matte"); return
    c=max(cnts,key=cv2.contourArea)
    fill=np.zeros_like(m); cv2.drawContours(fill,[c],-1,255,-1)
    c=max(cv2.findContours(fill,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)[0],key=cv2.contourArea)
    P=A.spline(c.reshape(-1,2).astype(float),sf)
    ov=canvas.copy(); cv2.polylines(ov,[P.astype(np.int32)],True,(255,60,60),2)
    cv2.imwrite(os.path.join(A.OUT,f"rembg_overlay_{base}.png"),ov)
    A.export(base, A.rotate_principal(P)/A.SCALE)

if __name__=="__main__": main()
