/** Minimal ZIP writer: STORE (no compression) entries with CRC-32, UTF-8 names, no ZIP64 (entries and archive under 4 GiB). Pure. */

import { crc32 } from './crc32';

export interface ZipEntry {
  /** Path inside the archive, forward slashes, no leading slash. */
  readonly name: string;
  readonly data: Uint8Array;
}

/** DOS date 1980-01-01 00:00: a fixed timestamp keeps archives byte-reproducible. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;

function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

/** The archive bytes for `entries` in the given order. */
export function zipStore(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const prepared = entries.map((entry) => ({ ...entry, nameBytes: encoder.encode(entry.name), crc: crc32(entry.data) }));
  const localSize = prepared.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.data.length, 0);
  const centralSize = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let at = 0;
  for (const e of prepared) {
    offsets.push(at);
    u32(view, at, 0x04034b50);
    u16(view, at + 4, 20);
    u16(view, at + 6, UTF8_FLAG);
    u16(view, at + 8, 0);
    u16(view, at + 10, DOS_TIME);
    u16(view, at + 12, DOS_DATE);
    u32(view, at + 14, e.crc);
    u32(view, at + 18, e.data.length);
    u32(view, at + 22, e.data.length);
    u16(view, at + 26, e.nameBytes.length);
    u16(view, at + 28, 0);
    out.set(e.nameBytes, at + 30);
    out.set(e.data, at + 30 + e.nameBytes.length);
    at += 30 + e.nameBytes.length + e.data.length;
  }
  const centralStart = at;
  prepared.forEach((e, index) => {
    u32(view, at, 0x02014b50);
    u16(view, at + 4, 20);
    u16(view, at + 6, 20);
    u16(view, at + 8, UTF8_FLAG);
    u16(view, at + 10, 0);
    u16(view, at + 12, DOS_TIME);
    u16(view, at + 14, DOS_DATE);
    u32(view, at + 16, e.crc);
    u32(view, at + 20, e.data.length);
    u32(view, at + 24, e.data.length);
    u16(view, at + 28, e.nameBytes.length);
    u32(view, at + 42, offsets[index] ?? 0);
    out.set(e.nameBytes, at + 46);
    at += 46 + e.nameBytes.length;
  });
  u32(view, at, 0x06054b50);
  u16(view, at + 8, prepared.length);
  u16(view, at + 10, prepared.length);
  u32(view, at + 12, centralSize);
  u32(view, at + 16, centralStart);
  return out;
}

/** An entry whose bytes are already stored (method 0) or deflated (method 8) in chunks, with the CRC-32 and size of the uncompressed data. */
export interface ZipChunkedEntry {
  readonly name: string;
  readonly method: 0 | 8;
  readonly crc: number;
  readonly size: number;
  readonly chunks: readonly Uint8Array[];
  readonly storedSize: number;
}

/** Archive of chunked entries (sizes below 4 GiB, no ZIP64); the entry bytes are copied once. */
export function zipChunked(entries: readonly ZipChunkedEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const prepared = entries.map((entry) => ({ ...entry, nameBytes: encoder.encode(entry.name) }));
  const localSize = prepared.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.storedSize, 0);
  const centralSize = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let at = 0;
  for (const e of prepared) {
    offsets.push(at);
    u32(view, at, 0x04034b50);
    u16(view, at + 4, 20);
    u16(view, at + 6, UTF8_FLAG);
    u16(view, at + 8, e.method);
    u16(view, at + 10, DOS_TIME);
    u16(view, at + 12, DOS_DATE);
    u32(view, at + 14, e.crc);
    u32(view, at + 18, e.storedSize);
    u32(view, at + 22, e.size);
    u16(view, at + 26, e.nameBytes.length);
    out.set(e.nameBytes, at + 30);
    at += 30 + e.nameBytes.length;
    for (const chunk of e.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
  }
  const centralStart = at;
  prepared.forEach((e, index) => {
    u32(view, at, 0x02014b50);
    u16(view, at + 4, 20);
    u16(view, at + 6, 20);
    u16(view, at + 8, UTF8_FLAG);
    u16(view, at + 10, e.method);
    u16(view, at + 12, DOS_TIME);
    u16(view, at + 14, DOS_DATE);
    u32(view, at + 16, e.crc);
    u32(view, at + 20, e.storedSize);
    u32(view, at + 24, e.size);
    u16(view, at + 28, e.nameBytes.length);
    u32(view, at + 42, offsets[index] ?? 0);
    out.set(e.nameBytes, at + 46);
    at += 46 + e.nameBytes.length;
  });
  u32(view, at, 0x06054b50);
  u16(view, at + 8, prepared.length);
  u16(view, at + 10, prepared.length);
  u32(view, at + 12, centralSize);
  u32(view, at + 16, centralStart);
  return out;
}
