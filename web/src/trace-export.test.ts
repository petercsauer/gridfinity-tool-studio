import { describe, expect, it } from 'vitest';
import type { Ring } from './geometry/pocket';
import { traceDxf, traceSvg } from './trace-export';

const circle = (r: number, n = 36): Ring => {
  const P: Ring = Array.from({ length: n }, (_, k) => [r * Math.cos((2 * Math.PI * k) / n) + 3, r * Math.sin((2 * Math.PI * k) / n) - 7]);
  return [...P, P[0]!]; // closed, as the pipeline's rings are
};
const layers = { tool: circle(10), pocket: circle(12.5) };

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
