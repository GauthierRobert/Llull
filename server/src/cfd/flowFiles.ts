/**
 * Decoders of the two result files the flow queries store (`LLSL` slice patch, `LLST` streamline polylines) for the headless render
 * (`flowRender.ts`). The viewport has its own copy in `src/ui` (a host may not import the UI); both read the same `llull-compute` format.
 */

import type { Vec3 } from '@core/model/types';

export interface SliceFile {
  readonly samples: number;
  readonly origin: Vec3;
  readonly axisU: Vec3;
  readonly axisV: Vec3;
  readonly spacingM: number;
  /** Row-major in v then u, `samples` squared; NaN = no value. */
  readonly values: Float32Array;
}

/** Polyline `k` is points `offsets[k] .. offsets[k + 1]` (world metres, speed in m/s). */
export interface StreamlinesFile {
  readonly lineCount: number;
  readonly offsets: Uint32Array;
  readonly positions: Float32Array;
  readonly speeds: Float32Array;
}

const SLICE_HEADER_BYTES = 72;
const STREAMLINES_HEADER_BYTES = 16;
const MAX_SAMPLES = 512;
const MAX_LINES = 4096;
const MAX_POINTS = 4_000_000;

const hasMagic = (bytes: Uint8Array, text: string): boolean => [...text].every((char, k) => bytes[k] === char.charCodeAt(0));

function words<T extends Float32Array | Uint32Array>(
  bytes: Uint8Array,
  from: number,
  count: number,
  kind: new (buffer: ArrayBuffer) => T,
): T {
  // Uint8Array.from copies: a Node Buffer's slice is a view over a shared pool, whose `.buffer` is not these bytes.
  return new kind(Uint8Array.from(bytes.subarray(from, from + count * 4)).buffer);
}

const vec3At = (floats: Float32Array, at: number): Vec3 => [floats[at] ?? 0, floats[at + 1] ?? 0, floats[at + 2] ?? 0];

/** The slice patch of an `LLSL` file, or what is wrong with it. */
export function parseSliceFile(bytes: Uint8Array): SliceFile | string {
  if (bytes.length < SLICE_HEADER_BYTES || !hasMagic(bytes, 'LLSL')) return 'the file is not an LLSL slice';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [nu, nv] = [view.getUint32(8, true), view.getUint32(12, true)];
  if (view.getUint32(4, true) !== 1 || nu !== nv || nu < 2 || nu > MAX_SAMPLES) return `unsupported slice (version, ${nu} x ${nv} samples)`;
  if (bytes.length !== SLICE_HEADER_BYTES + 4 * nu * nv) return 'the slice file has the wrong length';
  const header = words(bytes, 16, 10, Float32Array);
  if (!header.every(Number.isFinite) || (header[9] ?? 0) <= 0)
    return 'the slice header holds a non-finite number or a non-positive spacing';
  return {
    samples: nu,
    origin: vec3At(header, 0),
    axisU: vec3At(header, 3),
    axisV: vec3At(header, 6),
    spacingM: header[9] ?? 0,
    values: words(bytes, SLICE_HEADER_BYTES, nu * nv, Float32Array),
  };
}

/** The polylines of an `LLST` file, or what is wrong with it. */
export function parseStreamlinesFile(bytes: Uint8Array): StreamlinesFile | string {
  if (bytes.length < STREAMLINES_HEADER_BYTES || !hasMagic(bytes, 'LLST')) return 'the file is not an LLST streamline file';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [lineCount, pointCount] = [view.getUint32(8, true), view.getUint32(12, true)];
  if (view.getUint32(4, true) !== 1) return 'unsupported streamline file version';
  if (lineCount > MAX_LINES || pointCount > MAX_POINTS)
    return `the streamline file declares ${lineCount} lines and ${pointCount} points: too many`;
  if (bytes.length !== STREAMLINES_HEADER_BYTES + 4 * (lineCount + 1) + 16 * pointCount) return 'the streamline file has the wrong length';
  const offsets = words(bytes, STREAMLINES_HEADER_BYTES, lineCount + 1, Uint32Array);
  if (offsets[0] !== 0 || offsets[lineCount] !== pointCount || offsets.some((at, k) => k > 0 && at < (offsets[k - 1] ?? 0)))
    return 'the streamline offsets are inconsistent';
  const positionsAt = STREAMLINES_HEADER_BYTES + 4 * (lineCount + 1);
  return {
    lineCount,
    offsets,
    positions: words(bytes, positionsAt, 3 * pointCount, Float32Array),
    speeds: words(bytes, positionsAt + 12 * pointCount, pointCount, Float32Array),
  };
}
