#!/usr/bin/env python3
"""Lay the four tool pockets onto a 42 mm gridfinity baseplate grid. Each tool
gets the smallest whole-cell footprint that holds its pocket (centered in it).
Renders a to-scale preview PNG + a combined SVG. Run with -I."""
import os, numpy as np
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

OUT=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),"out")
CELL=42.0; GAP=0.0
TOOLS=["needlenose","combopliers","flushcutter","stripper"]
TITLE={"needlenose":"Needle-nose","combopliers":"Combo pliers",
       "flushcutter":"Flush cutter","stripper":"Wire stripper"}

polys={n:np.load(os.path.join(OUT,f"{n}_pocket.npy")) for n in TOOLS}
tools={n:np.load(os.path.join(OUT,f"{n}_toolref.npy")) for n in TOOLS}

# cell footprint per tool
foot={}
for n in TOOLS:
    w,h=polys[n][:,0].max(),polys[n][:,1].max()
    foot[n]=(int(np.ceil(w/CELL)),int(np.ceil(h/CELL)))
rows=max(c for _,c in foot.values())                 # baseplate height (cells)
# place left-to-right, bottom-aligned
x0=0.0; placements={}; svg_paths=[]
for n in TOOLS:
    cw,ch=foot[n]; W=cw*CELL; H=ch*CELL
    p=polys[n]; t=tools[n]
    ox=x0+(W-p[:,0].max())/2; oy=(H-p[:,1].max())/2    # center pocket in footprint
    placements[n]=(x0,0,cw,ch,ox,oy)
    x0+=W+GAP
total_w=x0; total_h=rows*CELL

fig,ax=plt.subplots(figsize=(total_w/25.4,total_h/25.4+0.6))
# baseplate cells
gx=0.0
for n in TOOLS:
    bx,by,cw,ch,ox,oy=placements[n]
    for i in range(cw):
        for j in range(ch):
            ax.add_patch(Rectangle((bx+i*CELL,by+j*CELL),CELL,CELL,
                         facecolor="none",edgecolor="#bcd",lw=0.8,zorder=1))
    p=polys[n]+[ox,oy]; t=tools[n]+[ox,oy]
    ax.fill(p[:,0],p[:,1],facecolor="#fde0e0",edgecolor="#d81f1f",lw=1.6,zorder=2)
    ax.plot(t[:,0],t[:,1],color="#2f6fd0",lw=1.1,zorder=3)
    ax.text(bx+cw*CELL/2,rows*CELL-6,f"{TITLE[n]}\n{cw}x{ch} cells",
            ha="center",va="top",fontsize=8,zorder=4)
ax.set_xlim(-4,total_w+4); ax.set_ylim(total_h+4,-4); ax.set_aspect("equal"); ax.axis("off")
ax.set_title(f"gridfinity layout — {CELL:.0f} mm cells   "
             f"({int(total_w//CELL)}x{rows} baseplate, {total_w:.0f} x {total_h:.0f} mm)",fontsize=11)
fig.tight_layout(); fig.savefig(os.path.join(OUT,"gridfinity_layout.png"),dpi=130,bbox_inches="tight")
print("wrote out/gridfinity_layout.png")

# combined SVG (red pockets + blue outlines + grid), mm
el=[]
for n in TOOLS:
    bx,by,cw,ch,ox,oy=placements[n]
    for i in range(cw):
        for j in range(ch):
            el.append(f'<rect x="{bx+i*CELL:.1f}" y="{by+j*CELL:.1f}" width="{CELL}" height="{CELL}" fill="none" stroke="#bcd" stroke-width="0.3"/>')
    p=polys[n]+[ox,oy]; t=tools[n]+[ox,oy]
    el.append('<path d="M '+" L ".join(f"{a:.2f},{b:.2f}" for a,b in p)+' Z" fill="#fde0e0" fill-opacity="0.7" stroke="#d81f1f" stroke-width="0.5"/>')
    el.append('<path d="M '+" L ".join(f"{a:.2f},{b:.2f}" for a,b in t)+' Z" fill="none" stroke="#1f4e79" stroke-width="0.4"/>')
open(os.path.join(OUT,"tools_combined.svg"),"w",encoding="utf-8").write(
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_w:.1f}mm" height="{total_h:.1f}mm" '
    f'viewBox="-2 -2 {total_w+4:.1f} {total_h+4:.1f}">'+"".join(el)+"</svg>")
print(f"wrote out/tools_combined.svg  ({int(total_w//CELL)}x{rows} cells, {total_w:.0f}x{total_h:.0f} mm)")
for n in TOOLS: print(f"  {TITLE[n]}: {foot[n][0]}x{foot[n][1]} cells")
