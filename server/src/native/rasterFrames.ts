/**
 * Framing of the persistent scene raster `llull-compute raster-serve` (`solver/crates/llull-raster/src/serve.rs`, PERF1 §5 row 10): one
 * JSON header line, then exactly `bytes` payload bytes, both ways. A request carries the scalars of a `RasterScene`, the f64 counts of its
 * five buffers and the buffers as little-endian f64; a reply carries the RGBA and, when asked, the PNG `encodePng(…, true)` would write.
 */

import type { RasterScene } from '@core/model/raster';
import { isRecord } from '@lib/isRecord';
import { f64Bytes } from './computeJob';

/** Longest reply header line accepted (a reply header is under a kilobyte; the native side caps its warnings). */
const MAX_HEADER_BYTES = 64 * 1024;

interface RasterWarning {
  readonly code: string;
  readonly message: string;
}

export type RasterReply =
  | {
      readonly ok: true;
      readonly warnings: readonly RasterWarning[];
      readonly rgba: Uint8Array;
      /** Empty when the PNG was not asked for. */
      readonly png: Uint8Array;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The request bytes of one frame: header line + faces, fills, loops, points, strokes. */
export function encodeRasterRequest(scene: RasterScene, engine: 'gpu' | 'cpu', png: boolean): Buffer {
  const { faces, fills, loops, points, strokes, ...scalars } = scene;
  const buffers = [faces, fills, loops, points, strokes];
  const bytes = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const header = JSON.stringify({ ...scalars, engine, png, buffers: buffers.map((buffer) => buffer.length), bytes });
  return Buffer.concat([Buffer.from(`${header}\n`, 'utf8'), ...buffers.map(f64Bytes)]);
}

const isWarning = (value: unknown): value is RasterWarning =>
  isRecord(value) && typeof value['code'] === 'string' && typeof value['message'] === 'string';

/** A reply from its header and payload; throws on a header that does not describe its payload. */
function replyOf(header: Record<string, unknown>, payload: Buffer): RasterReply {
  const { ok, code, message, warnings, rgba, png } = header;
  if (ok !== true) {
    return {
      ok: false,
      code: typeof code === 'string' ? code : 'NATIVE_PROTOCOL',
      message: typeof message === 'string' ? message : 'the raster process refused the frame',
    };
  }
  if (typeof rgba !== 'number' || typeof png !== 'number' || rgba + png !== payload.length || !Array.isArray(warnings))
    throw new Error(`reply header ${JSON.stringify(header).slice(0, 200)} does not describe its ${payload.length}-byte payload`);
  return {
    ok: true,
    warnings: warnings.filter(isWarning),
    rgba: new Uint8Array(payload.buffer, payload.byteOffset, rgba),
    png: new Uint8Array(payload.buffer, payload.byteOffset + rgba, png),
  };
}

/** Incremental reader of replies from stdout chunks. `push` returns the replies completed so far; throws when the framing is lost. */
export interface RasterReplyReader {
  push(chunk: Uint8Array): RasterReply[];
}

export function createRasterReplyReader(): RasterReplyReader {
  let pending: Buffer[] = [];
  let size = 0;
  let header: Record<string, unknown> | null = null;
  let wanted = 0;

  const take = (count: number): Buffer => {
    const all = pending.length === 1 ? (pending[0] ?? Buffer.alloc(0)) : Buffer.concat(pending, size);
    const head = all.subarray(0, count);
    const rest = all.subarray(count);
    pending = rest.length === 0 ? [] : [rest];
    size = rest.length;
    return head;
  };

  /** The header line when one is complete, else null. */
  const nextHeader = (): Record<string, unknown> | null => {
    const all = pending.length === 1 ? (pending[0] ?? Buffer.alloc(0)) : Buffer.concat(pending, size);
    pending = all.length === 0 ? [] : [all];
    const end = all.indexOf(0x0a);
    if (end < 0) {
      if (size > MAX_HEADER_BYTES) throw new Error(`reply header longer than ${MAX_HEADER_BYTES} bytes`);
      return null;
    }
    const line = take(end + 1).toString('utf8', 0, end);
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed) || typeof parsed['bytes'] !== 'number' || !Number.isInteger(parsed['bytes']) || parsed['bytes'] < 0)
      throw new Error(`unreadable reply header: ${line.slice(0, 200)}`);
    return parsed;
  };

  return {
    push(chunk) {
      pending.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      size += chunk.byteLength;
      const replies: RasterReply[] = [];
      for (;;) {
        if (header === null) {
          header = nextHeader();
          if (header === null) return replies;
          wanted = header['bytes'] as number;
        }
        if (size < wanted) return replies;
        replies.push(replyOf(header, Buffer.from(take(wanted))));
        header = null;
      }
    },
  };
}
