/**
 * TypeScript reference for the native PNG encoder of `llull-raster` (PERF1 §5 row 10): small RGBA images that reach every branch of
 * `encodePng(…, true)` / `deflateRaw` (one pixel, noise without matches, flat runs of the longest match, a period at the edge of the
 * 32 KiB window, rows equal to the row above, a match at distance exactly 32 768, one a byte beyond it, a long match hidden behind more
 * than 24 newer candidates) and the sha256 of the PNG each one encodes to. `solver/crates/llull-raster/tests/png_reference.rs`
 * requires `png::encode_png` to write the same bytes. Regenerate with LLULL_WRITE_NATIVE_FIXTURES=1.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encodePng } from '@lib/png';

const FILE = path.resolve(__dirname, '../../../solver/crates/llull-raster/tests/fixtures/png.json');
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function image(width: number, height: number, value: (index: number) => number): { width: number; height: number; rgba: Uint8Array } {
  return { width, height, rgba: Uint8Array.from({ length: width * height * 4 }, (_, index) => value(index) & 0xff) };
}

function noise(seed: number): (index: number) => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 24) & 0xff;
  };
}

/** One noise row of `width` pixels with `edit` applied to its bytes (a single row: the PNG rows are its bytes after the filter byte). */
function row(width: number, seed: number, edit: (bytes: Uint8Array) => void): { width: number; height: number; rgba: Uint8Array } {
  const { rgba } = image(width, 1, noise(seed));
  edit(rgba);
  return { width, height: 1, rgba };
}

/** Bytes [1000, 1300) copied `distance` bytes later: at 32 768 a 258-byte match at the window edge, one further only literals. */
function copied(distance: number): (bytes: Uint8Array) => void {
  return (bytes) => void bytes.copyWithin(1000 + distance, 1000, 1300);
}

/** 30 earlier copies of one 3-byte prefix, each with its own tail; only the oldest shares the 60-byte tail of the last copy (chain cutoff 24). */
function chainCutoff(bytes: Uint8Array): void {
  const tail = Uint8Array.from({ length: 60 }, (_, k) => (k * 37 + 11) & 0xff);
  for (let k = 0; k <= 30; k += 1) {
    const at = 100 + k * 70;
    bytes.set([0xab, 0xcd, 0xef], at);
    if (k === 0 || k === 30) bytes.set(tail, at + 3);
    else bytes[at + 3] = (k * 5) & 0xff;
  }
}

const CASES = {
  pixel: image(1, 1, () => 0),
  tiny: image(3, 2, noise(7)),
  noise: image(64, 48, noise(11)),
  flat: image(100, 30, (index) => (index % 4 === 3 ? 255 : 40)),
  window: image(8193, 2, (index) => Math.floor(index / 4) % 8191),
  rows: image(90, 70, (index) => (index % 360) * 3 + (index % 4)),
  windowEdge: row(16384, 21, copied(32768)),
  pastWindow: row(16384, 21, copied(32769)),
  chainCutoff: row(600, 5, chainCutoff),
};

describe('PNG reference fixtures', () => {
  it('sha256 of encodePng(…, true) for images reaching every deflate branch', () => {
    const entries = Object.entries(CASES).map(([name, { width, height, rgba }]) => {
      const png = encodePng(width, height, rgba, true);
      expect(png.length).toBeGreaterThan(57);
      expect(inflateSync(Buffer.from(png.subarray(41, png.length - 12))).length).toBe(height * (width * 4 + 1));
      return { name, width, height, rgbaBase64: Buffer.from(rgba).toString('base64'), pngSha256: sha(png) };
    });
    const text = `${JSON.stringify(entries)}\n`;
    if (process.env['LLULL_WRITE_NATIVE_FIXTURES'] === '1') writeFileSync(FILE, text);
    const stored = readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
    expect(stored === text, 'png.json is out of date: run with LLULL_WRITE_NATIVE_FIXTURES=1').toBe(true);
  });
});
