import { inflateSync } from 'node:zlib';

/**
 * Independent PNG reader for issued renders (ISO/IEC 15948): signature, IHDR, concatenated IDAT inflated with node's zlib, the five
 * scanline filters undone. 8-bit greyscale / RGB / RGBA, non-interlaced only (what a renderer issues); anything else throws.
 */

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** Luminance per pixel, 0..255 (Rec.709 weights on the stored sRGB values). */
  readonly luma: Float64Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unfilter(data: Buffer, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x++) {
      const raw = data[y * (stride + 1) + 1 + x] ?? 0;
      const a = x >= bpp ? (out[y * stride + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= bpp && y > 0 ? (out[(y - 1) * stride + x - bpp] ?? 0) : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
      if (predictor === undefined) throw new Error(`PNG: unknown filter ${filter} on row ${y}`);
      out[y * stride + x] = (raw + predictor) & 255;
    }
  }
  return out;
}

export function decodePng(bytes: Uint8Array): DecodedImage {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!SIGNATURE.every((value, index) => buffer[index] === value)) throw new Error('PNG: bad signature');
  let offset = 8;
  let header: { width: number; height: number; depth: number; colorType: number; interlace: number } | null = null;
  const idat: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR')
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8] ?? 0,
        colorType: body[9] ?? 0,
        interlace: body[12] ?? 0,
      };
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (header === null) throw new Error('PNG: no IHDR');
  const channels = CHANNELS[header.colorType];
  if (header.depth !== 8 || channels === undefined || header.interlace !== 0)
    throw new Error(`PNG: unsupported depth ${header.depth} / colour type ${header.colorType} / interlace ${header.interlace}`);
  const pixels = unfilter(inflateSync(Buffer.concat(idat)), header.width, header.height, channels);
  const luma = new Float64Array(header.width * header.height);
  for (let index = 0; index < luma.length; index++) {
    const base = index * channels;
    luma[index] =
      channels === 1
        ? (pixels[base] ?? 0)
        : 0.2126 * (pixels[base] ?? 0) + 0.7152 * (pixels[base + 1] ?? 0) + 0.0722 * (pixels[base + 2] ?? 0);
  }
  return { width: header.width, height: header.height, luma };
}

/** Standard deviation of the luminance (0 = a blank picture). */
export function lumaSpread(image: DecodedImage): number {
  let sum = 0;
  for (const value of image.luma) sum += value;
  const mean = sum / image.luma.length;
  let squares = 0;
  for (const value of image.luma) squares += (value - mean) ** 2;
  return Math.sqrt(squares / image.luma.length);
}

/** Mean absolute luminance difference of two same-size pictures (0..255). */
export function meanAbsoluteDifference(a: DecodedImage, b: DecodedImage): number {
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  let sum = 0;
  for (let index = 0; index < a.luma.length; index++) sum += Math.abs((a.luma[index] ?? 0) - (b.luma[index] ?? 0));
  return sum / a.luma.length;
}
