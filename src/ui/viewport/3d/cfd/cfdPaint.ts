// Turns decoded flow files into what the overlay draws: a colour texture and quad for a slice, coloured line segments for streamlines.
// Pure (typed arrays in and out). The colour scale is the result scale of the other overlays (blue low -> red high).

import { resultColor } from '@lib/isoBands';
import type { Vec3 } from '@core/model/types';
import type { SliceFile, StreamlinesFile } from './cfdFiles';

export interface ValueRange {
  readonly min: number;
  readonly max: number;
}

/** `t` in [0, 1] of `value` on `range` (a zero range maps to the middle of the scale). */
export function scaleFraction(value: number, range: ValueRange): number {
  const span = range.max - range.min;
  return span > 0 ? Math.min(1, Math.max(0, (value - range.min) / span)) : 0.5;
}

const rgb = (t: number): [number, number, number] => {
  const hex = resultColor(t);
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
};

/** The 256-step ramp (rgb bytes), built once. */
const RAMP: readonly (readonly [number, number, number])[] = Array.from({ length: 256 }, (_, k) => rgb(k / 255));

const rampAt = (t: number): readonly [number, number, number] => RAMP[Math.round(t * 255)] ?? RAMP[0] ?? [0, 0, 255];

/** RGBA bytes of the patch, one texel per sample (v rows, u columns); no-value samples are transparent. */
export function sliceTexels(slice: SliceFile, range: ValueRange): Uint8Array {
  const texels = new Uint8Array(slice.values.length * 4);
  slice.values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    const [r, g, b] = rampAt(scaleFraction(value, range));
    texels.set([r, g, b, 255], index * 4);
  });
  return texels;
}

/** Corners of the patch quad (u0v0, u1v0, u1v1, u0v1) in scene units: each sample is a cell of one spacing centred on it. */
export function sliceCorners(slice: SliceFile, sceneUnitsPerMetre: number): Float32Array {
  const { origin, axisU, axisV, spacingM, samples } = slice;
  const [from, to] = [-0.5 * spacingM, (samples - 0.5) * spacingM];
  const corner = (s: number, t: number): Vec3 => [
    (origin[0] + s * axisU[0] + t * axisV[0]) * sceneUnitsPerMetre,
    (origin[1] + s * axisU[1] + t * axisV[1]) * sceneUnitsPerMetre,
    (origin[2] + s * axisU[2] + t * axisV[2]) * sceneUnitsPerMetre,
  ];
  return new Float32Array([...corner(from, from), ...corner(to, from), ...corner(to, to), ...corner(from, to)]);
}

export interface LineSegments {
  /** Pairs of points (x y z, scene units). */
  readonly positions: Float32Array;
  /** One rgb (0..1) per position. */
  readonly colors: Float32Array;
}

/** Each polyline as consecutive point pairs, coloured by the speed at the point. */
export function streamlineSegments(file: StreamlinesFile, range: ValueRange, sceneUnitsPerMetre: number): LineSegments {
  let segments = 0;
  for (let line = 0; line < file.lineCount; line += 1)
    segments += Math.max(0, (file.offsets[line + 1] ?? 0) - (file.offsets[line] ?? 0) - 1);
  const positions = new Float32Array(segments * 6);
  const colors = new Float32Array(segments * 6);
  let out = 0;
  for (let line = 0; line < file.lineCount; line += 1) {
    const [first, end] = [file.offsets[line] ?? 0, file.offsets[line + 1] ?? 0];
    for (let point = first; point + 1 < end; point += 1) {
      for (const at of [point, point + 1]) {
        const channels = rampAt(scaleFraction(file.speeds[at] ?? 0, range));
        for (let axis = 0; axis < 3; axis += 1) {
          positions[out] = (file.positions[3 * at + axis] ?? 0) * sceneUnitsPerMetre;
          colors[out] = (channels[axis] ?? 0) / 255;
          out += 1;
        }
      }
    }
  }
  return { positions, colors };
}
