/** Minimal ZIP reader (central directory): STORE and DEFLATE entries, no ZIP64, no encryption. Pure. */

import { inflateRaw } from './inflate';
import { LimitError } from './limitError';
import type { ZipEntry } from './zip';

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Default caps of an untrusted archive: 256 MiB of decompressed entries in total, 200 x expansion per entry (an importer that needs more names its own). */
const DEFAULT_MAX_BYTES = 256 * 2 ** 20;
const DEFAULT_MAX_RATIO = 200;
const RATIO_SLACK_BYTES = 65536;

export interface UnzipOptions {
  /** Entries whose name this accepts are read; the others are skipped without being inflated (default: all). */
  readonly select?: (name: string) => boolean;
  /** Largest decompressed size of one entry, and of all read entries together (default 256 MiB). */
  readonly maxBytes?: number;
  /** Largest decompressed / compressed ratio of one entry (plus 64 KiB of slack; default 200); inflating stops at that size. */
  readonly maxRatio?: number;
}

/**
 * The selected file entries of a ZIP archive, decompressed.
 * @invariant unselected entries are never inflated; selected ones are capped at `maxBytes` in total, so a zip bomb costs at most that much
 * @failure not a ZIP, truncated, entry data outside the archive, encrypted, ZIP64 or unknown compression -> Error; an entry that declares or
 *   inflates beyond the byte or ratio cap -> `LimitError` ZIP_LIMIT_EXCEEDED (limit + declared size), refused from its header before any inflating
 */
export function unzip(bytes: Uint8Array, options: UnzipOptions = {}): ZipEntry[] {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRatio = options.maxRatio ?? DEFAULT_MAX_RATIO;
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
    const declaredSize = view.getUint32(cursor + 24, true);
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
    else if (method === 8) data = inflateEntry(name, stored, declaredSize, budget, maxRatio);
    else throw new Error(`ZIP entry ${name} uses unsupported compression method ${method}`);
    budget -= data.length;
    if (budget < 0) throw new LimitError('ZIP_LIMIT_EXCEEDED', `entries exceed the ${maxBytes} byte limit`, maxBytes, maxBytes - budget);
    entries.push({ name, data });
  }
  return entries;
}

/** One DEFLATE entry under the remaining byte budget and the ratio cap: a header that already declares more is refused before inflating. */
function inflateEntry(name: string, stored: Uint8Array, declaredSize: number, budget: number, maxRatio: number): Uint8Array {
  const ratioCap = stored.length * maxRatio + RATIO_SLACK_BYTES;
  if (declaredSize > budget)
    throw new LimitError(
      'ZIP_LIMIT_EXCEEDED',
      `entry ${name} declares ${declaredSize} bytes, over the ${budget} byte limit`,
      budget,
      declaredSize,
    );
  if (declaredSize > ratioCap)
    throw new LimitError(
      'ZIP_LIMIT_EXCEEDED',
      `entry ${name} declares ${declaredSize} bytes from ${stored.length}, over the ${maxRatio}x expansion limit (${ratioCap} bytes)`,
      ratioCap,
      declaredSize,
    );
  const limit = Math.min(budget, ratioCap);
  try {
    return inflateRaw(stored, limit);
  } catch (error) {
    if (!(error instanceof LimitError)) throw error;
    throw new LimitError(
      'ZIP_LIMIT_EXCEEDED',
      `entry ${name} inflates beyond ${limit} bytes (declared ${declaredSize})`,
      limit,
      declaredSize,
    );
  }
}
