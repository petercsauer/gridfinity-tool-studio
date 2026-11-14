// The 2D trace as vector files at 1:1 scale in millimetres: SVG (laser cutters, Inkscape,
// Illustrator) and DXF R12 (CAD and CAM: Fusion, Onshape, AutoCAD, LightBurn).
import type { Ring } from './geometry/pocket';

export interface TraceLayers {
  /** Each part's traced tool outline, where it sits in the bin (mm, Y up). */
  tools: Ring[];
  /** Each part's pocket: the outline grown by the clearance, plus the finger slot (mm, Y up). */
  pockets: Ring[];
  /** Each part's id (`p1`, …), for the SVG paths' ids; without them the paths have none. */
  ids?: string[];
  /** The bin's outer rectangle, centred on the origin (mm); exported as its own layer when given. */
  bin?: { w: number; h: number };
}

const fmt = (v: number) => String(+v.toFixed(3));

/** The ring without a repeated closing point. */
function open(P: Ring): Ring {
  const n = P.length;
  return n > 1 && P[0]![0] === P[n - 1]![0] && P[0]![1] === P[n - 1]![1] ? P.slice(0, -1) : P;
}

interface Placed {
  tools: Ring[];
  pockets: Ring[];
  bin?: Ring;
  w: number;
  h: number;
}

/** Every ring moved so the bounding box of the pockets and the bin starts at (margin, margin). */
function placed(t: TraceLayers, margin: number): Placed {
  const bin: Ring | undefined = t.bin && [
    [-t.bin.w / 2, -t.bin.h / 2], [t.bin.w / 2, -t.bin.h / 2], [t.bin.w / 2, t.bin.h / 2], [-t.bin.w / 2, t.bin.h / 2],
  ];
  const pts = [...t.pockets.flat(), ...(bin ?? [])];
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  const x0 = Math.min(...xs) - margin, y0 = Math.min(...ys) - margin;
  const move = (P: Ring): Ring => open(P).map(([x, y]) => [x - x0, y - y0]);
  return {
    tools: t.tools.map(move), pockets: t.pockets.map(move), ...(bin ? { bin: move(bin) } : {}),
    w: Math.max(...xs) - x0 + margin, h: Math.max(...ys) - y0 + margin,
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** SVG sized in mm (1 user unit = 1 mm): the tools, the pockets and the bin as separate layers of closed
 * paths, one path per part (with its id as `tool-p1`, `pocket-p1`, … when the parts have ids). */
export function traceSvg(t: TraceLayers, name: string): string {
  const { tools, pockets, bin, w, h } = placed(t, 5);
  // SVG's Y axis points down; flip so the file matches the preview
  const d = (P: Ring) => 'M' + P.map(([x, y]) => `${fmt(x)} ${fmt(h - y)}`).join(' L') + ' Z';
  const paths = (layer: string, rings: Ring[]) => rings.map((P, i) => {
    const id = t.ids?.[i];
    return `    <path ${id ? `id="${esc(`${layer}-${id}`)}" ` : ''}d="${d(P)}"/>\n`;
  }).join('');
  const binLayer = bin ? `  <g id="bin" inkscape:groupmode="layer" inkscape:label="Bin outline" fill="none" stroke="#8e8e93" stroke-width="0.2">
    <path d="${d(bin)}"/>
  </g>
` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${fmt(w)}mm" height="${fmt(h)}mm" viewBox="0 0 ${fmt(w)} ${fmt(h)}">
  <title>${esc(name)} (Gridfinity Tool Studio, 1:1 mm)</title>
${binLayer}  <g id="tool" inkscape:groupmode="layer" inkscape:label="Tool outline" fill="none" stroke="#000" stroke-width="0.2">
${paths('tool', tools)}  </g>
  <g id="pocket" inkscape:groupmode="layer" inkscape:label="Pocket (clearance and finger slot)" fill="none" stroke="#0a84ff" stroke-width="0.2">
${paths('pocket', pockets)}  </g>
</svg>
`;
}

/** DXF R12 (AC1009) in mm: each outline a closed POLYLINE, on layers TOOL and POCKET, and the bin's on BIN
 * when it is given (a layer only when it has something on it). */
export function traceDxf(t: TraceLayers): string {
  const { tools, pockets, bin, w, h } = placed(t, 0);
  const layers = [['TOOL', 7, tools], ['POCKET', 5, pockets], ...(bin ? [['BIN', 8, [bin]] as const] : [])] as const;
  const out: (string | number)[] = [];
  const g = (code: number, value: string | number) => out.push(code, value);
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4); // millimetres
  g(9, '$MEASUREMENT'); g(70, 1); // metric
  g(9, '$EXTMIN'); g(10, 0); g(20, 0); g(30, 0);
  g(9, '$EXTMAX'); g(10, fmt(w)); g(20, fmt(h)); g(30, 0);
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length);
  for (const [layer, color] of layers) {
    g(0, 'LAYER'); g(2, layer); g(70, 0); g(62, color); g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const [layer, , rings] of layers) {
    for (const P of rings) {
      g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, 1); // closed
      for (const [x, y] of P) {
        g(0, 'VERTEX'); g(8, layer); g(10, fmt(x)); g(20, fmt(y)); g(30, 0);
      }
      g(0, 'SEQEND'); g(8, layer);
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  const lines: string[] = [];
  for (let i = 0; i < out.length; i += 2) lines.push(String(out[i]).padStart(3), String(out[i + 1]));
  return lines.join('\r\n') + '\r\n';
}
