// Decoders of the two binary result files the flow transports store (`llull-compute flow-query`): `LLSL` (a slice patch) and `LLST`
// (streamline polylines). Pure: bytes in, typed arrays out; nothing is computed about the flow.

import type { Vec3 } from '@core/model/types';

/** A sampled plane patch: sample `(iu, iv)` sits at `origin + iu spacing axisU + iv spacing axisV` (world metres); NaN = no value. */
export interface SliceFile {
  readonly samples: number;
  readonly origin: Vec3;
  readonly axisU: Vec3;
  readonly axisV: Vec3;
  readonly spacingM: number;
  readonly field: string;
  /** Row-major in v then u, `samples` squared. */
  readonly values: Float32Array;
  /** Range of the finite values; null when the whole patch is empty. */
  readonly range: { readonly min: number; readonly max: number } | null;
}

/** Polyline `k` is points `offsets[k] .. offsets[k + 1]` (world metres, speed in m/s). */
export interface StreamlinesFile {
  readonly lineCount: number;
  readonly pointCount: number;
  readonly offsets: Uint32Array;
  readonly positions: Float32Array;
  readonly speeds: Float32Array;
  readonly range: { readonly min: number; readonly max: number } | null;
}

const SLICE_HEADER_BYTES = 72;
const STREAMLINES_HEADER_BYTES = 16;
/** Named guard: the solver caps a patch at 512 samples a side. */
const MAX_SAMPLES = 512;

const magic = (bytes: Uint8Array, text: string): boolean => [...text].every((char, k) => bytes[k] === char.charCodeAt(0));

/** The little-endian f32 / u32 words of `bytes[from, from + count * 4)` in a fresh, aligned array. */
function words<T extends Float32Array | Uint32Array>(
  bytes: Uint8Array,
  from: number,
  count: number,
  kind: new (buffer: ArrayBuffer) => T,
): T {
  return new kind(bytes.slice(from, from + count * 4).buffer);
}

function rangeOf(values: Float32Array): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min <= max ? { min, max } : null;
}

const vec3At = (floats: Float32Array, at: number): Vec3 => [floats[at] ?? 0, floats[at + 1] ?? 0, floats[at + 2] ?? 0];

/** The slice patch of an `LLSL` file, or what is wrong with it. */
export function parseSliceFile(bytes: Uint8Array): SliceFile | string {
  if (bytes.length < SLICE_HEADER_BYTES || !magic(bytes, 'LLSL')) return 'The file is not an LLSL slice.';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [nu, nv] = [view.getUint32(8, true), view.getUint32(12, true)];
  if (view.getUint32(4, true) !== 1 || nu !== nv || nu < 2 || nu > MAX_SAMPLES)
    return `Unsupported slice (version, ${nu} x ${nv} samples).`;
  if (bytes.length !== SLICE_HEADER_BYTES + 4 * nu * nv) return 'The slice file has the wrong length.';
  const header = words(bytes, 16, 10, Float32Array);
  const values = words(bytes, SLICE_HEADER_BYTES, nu * nv, Float32Array);
  const name = new TextDecoder().decode(bytes.subarray(56, SLICE_HEADER_BYTES)).replace(/\0+$/, '');
  return {
    samples: nu,
    origin: vec3At(header, 0),
    axisU: vec3At(header, 3),
    axisV: vec3At(header, 6),
    spacingM: header[9] ?? 0,
    field: name,
    values,
    range: rangeOf(values),
  };
}

/** The polylines of an `LLST` file, or what is wrong with it. */
export function parseStreamlinesFile(bytes: Uint8Array): StreamlinesFile | string {
  if (bytes.length < STREAMLINES_HEADER_BYTES || !magic(bytes, 'LLST')) return 'The file is not an LLST streamline file.';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [lineCount, pointCount] = [view.getUint32(8, true), view.getUint32(12, true)];
  if (view.getUint32(4, true) !== 1) return 'Unsupported streamline file version.';
  if (bytes.length !== STREAMLINES_HEADER_BYTES + 4 * (lineCount + 1) + 16 * pointCount) return 'The streamline file has the wrong length.';
  const offsets = words(bytes, STREAMLINES_HEADER_BYTES, lineCount + 1, Uint32Array);
  if (offsets[lineCount] !== pointCount || offsets.some((at, k) => at > pointCount || (k > 0 && at < (offsets[k - 1] ?? 0))))
    return 'The streamline offsets are inconsistent.';
  const positionsAt = STREAMLINES_HEADER_BYTES + 4 * (lineCount + 1);
  const speeds = words(bytes, positionsAt + 12 * pointCount, pointCount, Float32Array);
  return {
    lineCount,
    pointCount,
    offsets,
    positions: words(bytes, positionsAt, 3 * pointCount, Float32Array),
    speeds,
    range: rangeOf(speeds),
  };
}
