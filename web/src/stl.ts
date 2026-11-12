// Binary STL from indexed triangle arrays (mm, Z up), as the Python reference exports it.

/** A binary STL: 80-byte header, triangle count, then per triangle a unit normal, three
 * vertices (float32 little-endian) and a zero attribute word. */
export function writeStl(positions: Float32Array, indices: Uint32Array, header = 'gridfinity tool studio'): ArrayBuffer {
  const n = Math.floor(indices.length / 3);
  const buf = new ArrayBuffer(84 + 50 * n);
  const dv = new DataView(buf);
  const head = new TextEncoder().encode(header.slice(0, 80));
  new Uint8Array(buf, 0, head.length).set(head);
  dv.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const a = indices[t * 3]! * 3, b = indices[t * 3 + 1]! * 3, c = indices[t * 3 + 2]! * 3;
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) { nx /= len; ny /= len; nz /= len; }
    for (const v of [nx, ny, nz]) { dv.setFloat32(o, v, true); o += 4; }
    for (const i of [a, b, c]) {
      for (let k = 0; k < 3; k++) { dv.setFloat32(o, positions[i + k]!, true); o += 4; }
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}

