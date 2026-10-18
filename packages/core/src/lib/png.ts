/**
 * Minimal PNG encoder: 8-bit RGBA, filter 0, zlib "stored" (uncompressed) deflate blocks. Pure (no DOM, no zlib dependency) so core can
 * embed textures in glTF exports.
 */

import { deflateRaw } from './deflate';

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib stream of `raw` using uncompressed deflate blocks (max 65535 bytes each). */
function storedZlib(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let offset = 2;
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535;
    const length = Math.min(65535, raw.length - start);
    out[offset] = i === blocks - 1 ? 1 : 0;
    out[offset + 1] = length & 0xff;
    out[offset + 2] = (length >>> 8) & 0xff;
    out[offset + 3] = ~length & 0xff;
    out[offset + 4] = (~length >>> 8) & 0xff;
    out.set(raw.subarray(start, start + length), offset + 5);
    offset += 5 + length;
  }
  new DataView(out.buffer).setUint32(offset, adler32(raw));
  return out;
}

/** zlib stream of `raw` compressed with `deflateRaw`. */
function deflatedZlib(raw: Uint8Array): Uint8Array {
  const body = deflateRaw(raw);
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(body, 2);
  new DataView(out.buffer).setUint32(2 + body.length, adler32(raw));
  return out;
}

/**
 * PNG bytes of a `width` × `height` RGBA image (`rgba.length === width * height * 4`). `compress` filters every row with "Up" and deflates
 * it (renders shrink ~20-50×); without it the rows are stored as is.
 * @invariant width, height >= 1
 */
export function encodePng(width: number, height: number, rgba: Uint8Array, compress = false): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    if (!compress || y === 0) raw.set(rgba.subarray(y * stride, (y + 1) * stride), row + 1);
    else {
      raw[row] = 2;
      for (let x = 0; x < stride; x++) raw[row + 1 + x] = ((rgba[y * stride + x] ?? 0) - (rgba[(y - 1) * stride + x] ?? 0)) & 0xff;
    }
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', compress ? deflatedZlib(raw) : storedZlib(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
