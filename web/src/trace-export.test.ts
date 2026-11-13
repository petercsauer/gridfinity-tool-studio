import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Ring } from './geometry/pocket';
import { traceDxf, traceSvg } from './trace-export';

const circle = (r: number, n = 36, cx = 3, cy = -7): Ring => {
  const P: Ring = Array.from({ length: n }, (_, k) => [r * Math.cos((2 * Math.PI * k) / n) + cx, r * Math.sin((2 * Math.PI * k) / n) + cy]);
  return [...P, P[0]!]; // closed, as the pipeline's rings are
};
const layers = { tools: [circle(10)], pockets: [circle(12.5)] };
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** DXF as [code, value] pairs. */
const pairs = (dxf: string) => {
  const lines = dxf.split('\r\n');
  const out: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([+lines[i]!, lines[i + 1]!]);
  return out;
};

describe('trace SVG', () => {
  const svg = traceSvg(layers, 'Pliers <big> & "co"');

  it('is sized in millimetres around the pocket with a 5 mm margin', () => {
    expect(svg).toMatch(/width="35mm" height="35mm" viewBox="0 0 35 35"/);
  });

  it('has the tool and pocket as separate closed paths, without the repeated point', () => {
    const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map((x) => x[1]!);
    expect(paths).toHaveLength(2);
    for (const d of paths) {
      expect(d.endsWith(' Z')).toBe(true);
      expect(d.split(' L')).toHaveLength(36);
    }
    expect(svg).toContain('id="tool"');
    expect(svg).toContain('id="pocket"');
  });

  it('escapes the tool name', () => {
    expect(svg).toContain('Pliers &lt;big&gt; &amp; &quot;co&quot;');
    expect(new DOMParserLike(svg).ok).toBe(true);
  });
});

/** Minimal well-formedness check (no DOM in the unit tests): tags balance. */
class DOMParserLike {
  ok: boolean;
  constructor(xml: string) {
    const stack: string[] = [];
    let ok = true;
    for (const m of xml.replace(/<\?[^>]*\?>/g, '').matchAll(/<(\/?)([a-z:]+)[^>]*?(\/?)>/gi)) {
      if (m[3]) continue;
      if (m[1]) ok &&= stack.pop() === m[2];
      else stack.push(m[2]!);
    }
    this.ok = ok && stack.length === 0;
  }
}

describe('trace DXF', () => {
  const dxf = traceDxf(layers);
  const p = pairs(dxf);

  it('is R12 in millimetres and ends with EOF', () => {
    const i = p.findIndex(([c, v]) => c === 9 && v === '$INSUNITS');
    expect(p[i + 1]).toEqual([70, '4']);
    expect(p.find(([c, v]) => c === 1 && v === 'AC1009')).toBeTruthy();
    expect(p.at(-1)).toEqual([0, 'EOF']);
  });

  it('has one closed polyline per layer with the ring vertices, in mm from the pocket corner', () => {
    const polys = p.flatMap(([c, v], i) => (c === 0 && v === 'POLYLINE' ? [i] : []));
    expect(polys).toHaveLength(2);
    expect(p.filter(([c, v]) => c === 0 && v === 'VERTEX')).toHaveLength(72);
    expect(p.filter(([c, v]) => c === 0 && v === 'SEQEND')).toHaveLength(2);
    expect(p[polys[0]! + 1]).toEqual([8, 'TOOL']);
    const xs = p.filter(([c]) => c === 10).map(([, v]) => +v);
    expect(Math.min(...xs)).toBeCloseTo(0, 3); // the pocket's left edge
    expect(Math.max(...xs)).toBeCloseTo(25, 3);
  });
});

describe('trace export of one part without a bin', () => {
  it('is byte for byte what a single tool always exported', () => {
    expect(sha(traceSvg(layers, 'Pliers'))).toBe('f2d782182def46ec');
    expect(sha(traceDxf(layers))).toBe('634b90a6a8a53948');
  });
});

describe('trace export of an arranged kit', () => {
  // two parts (p2 hidden, so left out) in a 2x1 bin, 83.5 x 41.5 mm, centred on the origin
  const parts = {
    tools: [circle(10, 36, -20, 0), circle(8, 24, 22, 2)],
    pockets: [circle(12.5, 36, -20, 0), circle(10.5, 24, 22, 2)],
    ids: ['p1', 'p3'],
  };
  const kit = { ...parts, bin: { w: 83.5, h: 41.5 } };

  it('SVG: one path per part in the tool and pocket layers, with the part ids, and a bin layer', () => {
    const svg = traceSvg(kit, 'Kit');
    expect(svg).toMatch(/width="93.5mm" height="51.5mm"/); // the bin plus the 5 mm margin
    expect(svg.match(/<path id="tool-p\d"/g)).toEqual(['<path id="tool-p1"', '<path id="tool-p3"']);
    expect(svg.match(/<path id="pocket-p\d"/g)).toEqual(['<path id="pocket-p1"', '<path id="pocket-p3"']);
    const bin = /<g id="bin"[^>]*>\s*<path d="([^"]+)"\/>/.exec(svg);
    expect(bin?.[1]).toBe('M5 46.5 L88.5 46.5 L88.5 5 L5 5 Z');
    expect(new DOMParserLike(svg).ok).toBe(true);
  });

  it('DXF: layers TOOL, POCKET and BIN with 2, 2 and 1 polylines, in mm from the bin corner', () => {
    const p = pairs(traceDxf(kit));
    const table = p.findIndex(([c, v]) => c === 2 && v === 'LAYER');
    expect(p[table + 1]).toEqual([70, '3']);
    const names = p.filter(([c], i) => c === 2 && p[i - 1]?.[1] === 'LAYER' && i > table + 1).map(([, v]) => v);
    expect(names).toEqual(['TOOL', 'POCKET', 'BIN']);
    const polys = p.flatMap(([c, v], i) => (c === 0 && v === 'POLYLINE' ? [p[i + 1]![1]] : []));
    expect(polys).toEqual(['TOOL', 'TOOL', 'POCKET', 'POCKET', 'BIN']);
    const xs = p.filter(([c]) => c === 10).map(([, v]) => +v);
    expect(Math.min(...xs)).toBeCloseTo(0, 3);
    expect(Math.max(...xs)).toBeCloseTo(83.5, 3);
  });

  it('DXF without a bin has no BIN layer', () => {
    const dxf = traceDxf(parts);
    expect(dxf).not.toContain('BIN');
    expect(dxf.match(/\r\nPOLYLINE\r\n/g)).toHaveLength(4);
  });
});
