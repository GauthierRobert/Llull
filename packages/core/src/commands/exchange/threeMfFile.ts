/**
 * 3MF package written straight to a file sink in chunks (05 IMP 14.12): no single string, no buffer of the whole package. The archive is the same bytes
 * `zipStreamed` builds in memory: stored `[Content_Types].xml` and `_rels/.rels`, then the model part deflated as it is produced; its local header is
 * written first with zero CRC and sizes and patched (`ThreeMfFileSink.patch`) once they are known, then the central directory.
 * @invariant the compressed model is never held: each deflate chunk goes to `sink.write` as it is produced
 * @invariant the archive stays under 4 GiB (no ZIP64) and the model XML under `MAX_DEFLATE_INPUT`; either limit throws `ThreeMfTooLargeError`
 */

import { CRC32_INIT, crc32, crc32Final, crc32Update } from '../../lib/crc32';
import { DeflateStream, MAX_DEFLATE_INPUT } from '../../lib/deflateStream';
import { DOS_DATE, DOS_TIME, UTF8_FLAG } from '../../lib/zip';
import { ThreeMfTooLargeError } from './threeMfStream';

/** What the writer needs from the host's file: append, and rewrite bytes already written. */
export interface ThreeMfFileSink {
  write(chunk: Uint8Array): void;
  patch(offset: number, bytes: Uint8Array): void;
}

/** Largest archive: the 32-bit sizes and offsets of ZIP without ZIP64, with a margin for the central directory. */
export const MAX_3MF_FILE_BYTES = 4_000_000_000;

interface ZipRecord {
  readonly nameBytes: Uint8Array;
  readonly method: 0 | 8;
  readonly crc: number;
  readonly compressed: number;
  readonly size: number;
  readonly offset: number;
}

function localHeader(nameBytes: Uint8Array, method: 0 | 8, crc: number, compressed: number, size: number): Uint8Array {
  const out = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(8, method, true);
  view.setUint16(10, DOS_TIME, true);
  view.setUint16(12, DOS_DATE, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, compressed, true);
  view.setUint32(22, size, true);
  view.setUint16(26, nameBytes.length, true);
  out.set(nameBytes, 30);
  return out;
}

function centralDirectory(records: readonly ZipRecord[], start: number): Uint8Array {
  const centralSize = records.reduce((sum, r) => sum + 46 + r.nameBytes.length, 0);
  const out = new Uint8Array(centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const r of records) {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, UTF8_FLAG, true);
    view.setUint16(at + 10, r.method, true);
    view.setUint16(at + 12, DOS_TIME, true);
    view.setUint16(at + 14, DOS_DATE, true);
    view.setUint32(at + 16, r.crc, true);
    view.setUint32(at + 20, r.compressed, true);
    view.setUint32(at + 24, r.size, true);
    view.setUint16(at + 28, r.nameBytes.length, true);
    view.setUint32(at + 42, r.offset, true);
    out.set(r.nameBytes, at + 46);
    at += 46 + r.nameBytes.length;
  }
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, records.length, true);
  view.setUint16(at + 10, records.length, true);
  view.setUint32(at + 12, centralSize, true);
  view.setUint32(at + 16, start, true);
  return out;
}

/**
 * Writes the package: the small `stored` parts as they are, then the model part, whose text `produce` pushes piece by piece. Returns the archive size.
 * @failure the archive passes `limit` bytes or the model XML passes `MAX_DEFLATE_INPUT` -> ThreeMfTooLargeError (the sink holds a partial file: the caller discards it)
 */
export function writeThreeMfPackage(
  sink: ThreeMfFileSink,
  stored: ReadonlyArray<{ readonly name: string; readonly text: string }>,
  modelName: string,
  produce: (push: (text: string) => void) => void,
  limit: number = MAX_3MF_FILE_BYTES,
): number {
  const encoder = new TextEncoder();
  const records: ZipRecord[] = [];
  let offset = 0;
  let xmlBytes = 0;
  const put = (bytes: Uint8Array): void => {
    sink.write(bytes);
    offset += bytes.length;
  };
  for (const part of stored) {
    const data = encoder.encode(part.text);
    const nameBytes = encoder.encode(part.name);
    records.push({ nameBytes, method: 0, crc: crc32(data), compressed: data.length, size: data.length, offset });
    put(localHeader(nameBytes, 0, crc32(data), data.length, data.length));
    put(data);
  }
  const nameBytes = encoder.encode(modelName);
  const modelOffset = offset;
  put(localHeader(nameBytes, 8, 0, 0, 0));
  const dataStart = offset;
  const deflate = new DeflateStream((chunk) => {
    put(chunk);
    if (offset > limit) throw new ThreeMfTooLargeError(xmlBytes);
  });
  let crc = CRC32_INIT;
  produce((text) => {
    const bytes = encoder.encode(text);
    crc = crc32Update(crc, bytes);
    xmlBytes += bytes.length;
    if (xmlBytes > MAX_DEFLATE_INPUT) throw new ThreeMfTooLargeError(xmlBytes);
    deflate.write(bytes);
  });
  deflate.finish();
  const [crcValue, compressed] = [crc32Final(crc), offset - dataStart];
  const sizes = new Uint8Array(12);
  const view = new DataView(sizes.buffer);
  view.setUint32(0, crcValue, true);
  view.setUint32(4, compressed, true);
  view.setUint32(8, xmlBytes, true);
  sink.patch(modelOffset + 14, sizes);
  records.push({ nameBytes, method: 8, crc: crcValue, compressed, size: xmlBytes, offset: modelOffset });
  put(centralDirectory(records, offset));
  return offset;
}
