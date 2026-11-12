// The Trace pane: the perspective-corrected calibration sheet with the tool (blue) and
// pocket (red) outlines drawn where the tool lies on the paper, all in sheet mm.
import type { OutlineResult } from './worker/protocol';

export const isDark = () => document.documentElement.dataset.theme === 'dark';

function rgba(col: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(col);
  if (!m) return col;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export class TraceView {
  private readonly ctx: CanvasRenderingContext2D;
  private image = new Image();
  private imageUrl = '';
  private outline: OutlineResult | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** Show a new outline; loads its sheet image if it changed. */
  show(outline: OutlineResult): void {
    this.outline = outline;
    if (outline.sheetImage !== this.imageUrl) {
      this.imageUrl = outline.sheetImage;
      const img = new Image();
      img.onload = () => {
        if (this.image === img) this.draw();
      };
      img.src = outline.sheetImage;
      this.image = img;
    }
    this.draw();
  }

  draw(): void {
    const { canvas: flat, ctx } = this;
    const r = flat.parentElement!.getBoundingClientRect();
    const dpr = devicePixelRatio;
    flat.width = r.width * dpr;
    flat.height = r.height * dpr;
    const W = flat.width;
    const H = flat.height;
    const cs = getComputedStyle(document.documentElement);
    const cTool = cs.getPropertyValue('--trace-tool').trim();
    const cPocket = cs.getPropertyValue('--trace-pocket').trim();
    ctx.clearRect(0, 0, W, H);
    const o = this.outline;
    if (!o) return;
    // the whole calibration sheet, fitted to the pane
    const [bx0, by0, bx1, by1] = o.sheetBox;
    const bw = bx1 - bx0;
    const bh = by1 - by0;
    const pad = 28 * dpr;
    const s = Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh);
    const ox = (W - bw * s) / 2;
    const oy = (H - bh * s) / 2;
    const img = this.image;
    if (img.complete && img.naturalWidth) {
      ctx.save();
      ctx.shadowColor = isDark() ? 'rgba(0,0,0,.55)' : 'rgba(0,0,0,.18)';
      ctx.shadowBlur = 18 * dpr;
      ctx.shadowOffsetY = 4 * dpr;
      ctx.beginPath();
      ctx.roundRect(ox, oy, bw * s, bh * s, 8 * dpr);
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(ox, oy, bw * s, bh * s, 8 * dpr);
      ctx.clip();
      ctx.drawImage(img, ox, oy, bw * s, bh * s);
      ctx.restore();
    }
    const path = (pts: [number, number][]) => {
      ctx.beginPath();
      pts.forEach(([px, py], i) => {
        const x = ox + (px - bx0) * s;
        const y = oy + (py - by0) * s;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
    };
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const halo = 'rgba(255,255,255,.7)'; // the paper is light in both themes
    path(o.sheetPocket);
    ctx.lineWidth = 4 * dpr;
    ctx.strokeStyle = halo;
    ctx.stroke();
    ctx.fillStyle = rgba(cPocket, 0.14);
    ctx.fill();
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = cPocket;
    ctx.stroke();
    path(o.sheetTool);
    ctx.lineWidth = 3.5 * dpr;
    ctx.strokeStyle = halo;
    ctx.stroke();
    ctx.lineWidth = 1.6 * dpr;
    ctx.strokeStyle = cTool;
    ctx.stroke();
    flat.parentElement!.classList.add('ready');
  }
}
