/** Minimal ZIP reader (central directory): STORE and DEFLATE entries, no ZIP64, no encryption. Pure. */

import { inflateRaw } from './inflate';
import type { ZipEntry } from './zip';

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export interface UnzipOptions {
  /** Entries whose name this accepts are read; the others are skipped without being inflated (default: all). */
  readonly select?: (name: string) => boolean;
  /** Largest decompressed size of one entry, and of all read entries together. */
  readonly maxBytes?: number;
}

/**
 * The selected file entries of a ZIP archive, decompressed.
 * @invariant unselected entries are never inflated; selected ones are capped at `maxBytes` in total, so a zip bomb costs at most that much
 * @failure not a ZIP, truncated, entry data outside the archive, encrypted, ZIP64, unknown compression or over the byte cap -> Error
 */
export function unzip(bytes: Uint8Array, options: UnzipOptions = {}): ZipEntry[] {
  const maxBytes = options.maxBytes ?? 1 << 30;
  let budget = maxBytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== END_SIGNATURE) end--;
  if (end < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) throw new Error('corrupt ZIP central directory');
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if ((flags & 1) !== 0) throw new Error(`ZIP entry ${name} is encrypted`);
    if (name.endsWith('/') || (options.select !== undefined && !options.select(name))) continue;
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE)
      throw new Error(`corrupt ZIP entry ${name}`);
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (dataStart + compressedSize > bytes.length) throw new Error(`ZIP entry ${name} extends beyond the archive`);
    const stored = bytes.subarray(dataStart, dataStart + compressedSize);
    let data: Uint8Array;
    if (method === 0) data = stored;
    else if (method === 8) data = inflateRaw(stored, budget);
    else throw new Error(`ZIP entry ${name} uses unsupported compression method ${method}`);
    budget -= data.length;
    if (budget < 0) throw new Error(`ZIP entries exceed the ${maxBytes} byte limit`);
    entries.push({ name, data });
  }
  return entries;
}
