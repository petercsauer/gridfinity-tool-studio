#!/usr/bin/env python3
"""Generate a print-at-100% Letter calibration sheet with 4 ArUco markers at
known mm positions + light mm/inch grid + rulers. Outputs PDF (exact scale),
PNG preview, and sheet_markers.json (marker corner coords in mm) for analysis.
Run with -I."""
import os, json, numpy as np, cv2
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

OUT=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),"out")
import sys
PAGES={'letter':(215.9,279.4),'a4':(210.0,297.0)}
SIZE=sys.argv[1] if len(sys.argv)>1 else 'letter'
PW,PH=PAGES[SIZE]                    # page size mm (marker layout identical across sizes)
MARK=24.0                            # marker edge mm
# marker centers (mm from top-left) and ids
CENTERS=[(30,34,0),(185.9,34,1),(185.9,245.4,2),(30,245.4,3)]
DICT=cv2.aruco.DICT_4X4_50

def marker_corners_mm(cx,cy):
    h=MARK/2
    # TL,TR,BR,BL in mm (image/page coords, y down)
    return [(cx-h,cy-h),(cx+h,cy-h),(cx+h,cy+h),(cx-h,cy+h)]

def main():
    d=cv2.aruco.getPredefinedDictionary(DICT)
    fig=plt.figure(figsize=(PW/25.4,PH/25.4))
    ax=fig.add_axes([0,0,1,1]); ax.set_xlim(0,PW); ax.set_ylim(PH,0)  # y down
    ax.set_aspect('equal'); ax.axis('off')

    # ---- grid region
    gx0,gx1,gy0,gy1=16,199.9,58,224
    for x in np.arange(gx0,gx1+0.01,10):
        major=abs(x%50)<0.01
        ax.add_line(Line2D([x,x],[gy0,gy1],color=('0.70' if major else '0.85'),lw=(0.6 if major else 0.35)))
    for y in np.arange(gy0,gy1+0.01,10):
        major=abs((y-gy0)%50)<0.01
        ax.add_line(Line2D([gx0,gx1],[y,y],color=('0.70' if major else '0.85'),lw=(0.6 if major else 0.35)))

    # ---- top inch ruler + left cm ruler (black, thin)
    ry=52
    for i in range(0,8):                        # inches across
        for q in range(0,8):
            xx=gx0+(i*25.4)+q*25.4/8
            if xx>gx1: break
            h=3.5 if q==0 else (2.2 if q==4 else 1.3)
            ax.add_line(Line2D([xx,xx],[ry,ry-h],color='k',lw=0.5))
        ax.text(gx0+i*25.4,ry-4.2,f'{i}"',ha='center',va='bottom',fontsize=5)
    rx=11
    for c in range(0,21):                        # cm down
        yy=gy0+c*10
        if yy>gy1: break
        h=3.5 if c%5==0 else 1.8
        ax.add_line(Line2D([rx,rx+h],[yy,yy],color='k',lw=0.5))
        if c%5==0: ax.text(rx-0.6,yy,f'{c}',ha='right',va='center',fontsize=5)
    ax.text(rx-0.6,gy0-5,'cm',ha='right',va='center',fontsize=5)

    # ---- markers (white backing so grid doesn't bleed under them)
    for cx,cy,mid in CENTERS:
        img=cv2.aruco.generateImageMarker(d,mid,300)   # black on white, incl border
        pad=int(300*0.18); big=np.full((300+2*pad,)*2,255,np.uint8); big[pad:pad+300,pad:pad+300]=img
        span=MARK*(1+2*0.18)
        ax.imshow(big,cmap='gray',vmin=0,vmax=255,origin='upper',
                  extent=[cx-span/2,cx+span/2,cy+span/2,cy-span/2],zorder=5,interpolation='nearest')
        ax.text(cx,cy+span/2+3.5,f'id {mid}',ha='center',va='top',fontsize=4.5,color='0.4',zorder=6)

    # ---- title + instructions
    ax.text(PW/2,20,'Tool tracing calibration sheet',ha='center',va='center',fontsize=11,weight='bold')
    ax.text(PW/2,27,'Print at 100% (Actual Size / no "fit to page").',ha='center',va='center',fontsize=7)
    tips=['1. Lay ONE tool flat on the sheet. Bigger than the grid is fine.',
          '2. Hold the camera level, straight above the sheet, with the flash on.',
          '3. iPhone: Settings > Camera > Grid on, then line up the two crosshairs before shooting.',
          '4. Keep all four corner markers uncovered and fully in the frame.']
    for i,t in enumerate(tips):
        ax.text(PW/2,232+i*5.0,t,ha='center',va='center',fontsize=6)

    # ---- 100 mm print-check bar (centered, below the grid, clear of markers)
    bx,by=58,265
    ax.add_line(Line2D([bx,bx+100],[by,by],color='k',lw=0.8))
    for xx in (bx,bx+100): ax.add_line(Line2D([xx,xx],[by-2,by+2],color='k',lw=0.8))
    ax.text(bx+50,by-2.5,'100.0 mm  (measure after printing to confirm scale)',ha='center',va='bottom',fontsize=6)
    ax.text(bx+50,by+4,'=  3.937 in',ha='center',va='top',fontsize=5,color='0.4')

    fig.savefig(os.path.join(OUT,f"calibration_sheet_{SIZE}.pdf"))
    if SIZE=="letter": fig.savefig(os.path.join(OUT,"calibration_sheet.pdf"))
    fig.savefig(os.path.join(OUT,f"calibration_sheet_{SIZE}_preview.png"),dpi=150)
    print(f"wrote out/calibration_sheet_{SIZE}.pdf + preview")

    meta={"page_mm":[PW,PH],"marker_edge_mm":MARK,"dict":"DICT_4X4_50",
          "markers":{mid:marker_corners_mm(cx,cy) for cx,cy,mid in CENTERS}}
    json.dump(meta,open(os.path.join(OUT,"sheet_markers.json"),"w"),indent=1)
    print("wrote out/sheet_markers.json")

if __name__=="__main__": main()
