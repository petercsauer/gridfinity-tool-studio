// Test helper: decode the 8-bit grayscale preset mask PNGs in assets/presets (opencv.js has no imdecode).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import type { Mask } from '../vision/outline';

const ROOT = new URL('../../../', import.meta.url);

/** Decode a non-interlaced 8-bit grayscale PNG from a repo-relative path. */
export function readMaskPng(repoPath: string): Mask {
  const buf = readFileSync(fileURLToPath(new URL(repoPath, ROOT)));
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 0 || body[12] !== 0) throw new Error(`${repoPath}: not an 8-bit grayscale PNG`);
    } else if (type === 'IDAT') idat.push(body);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (width + 1)]!;
    const row = raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1));
    for (let x = 0; x < width; x++) {
      const left = x > 0 ? data[y * width + x - 1]! : 0;
      const up = y > 0 ? data[(y - 1) * width + x]! : 0;
      const ul = x > 0 && y > 0 ? data[(y - 1) * width + x - 1]! : 0;
      let pred = 0;
      if (filter === 1) pred = left;
      else if (filter === 2) pred = up;
      else if (filter === 3) pred = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
      }
      data[y * width + x] = (row[x]! + pred) & 255;
    }
  }
  return { width, height, data };
}
