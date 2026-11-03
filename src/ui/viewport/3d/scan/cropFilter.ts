// Document crop boxes (`scan.crops`, set by `set_scan_crop`) applied to the drawn points: a point is kept when every crop that applies to
// its cloud keeps it. Presentation only: the points themselves are untouched, and the toggle is a UI preference.

import type { Vec3 } from '@core/model/vectors';

export interface CropLike {
  readonly cloudIds: readonly string[];
  readonly min: Vec3;
  readonly max: Vec3;
  readonly keep: 'inside' | 'outside';
}

/** Crops that apply to `cloudId` (an empty `cloudIds` = every cloud). */
export function cropsFor(crops: readonly CropLike[], cloudId: string): readonly CropLike[] {
  return crops.filter((crop) => crop.cloudIds.length === 0 || crop.cloudIds.includes(cloudId));
}

function insideBox(crop: CropLike, x: number, y: number, z: number): boolean {
  return x >= crop.min[0] && x <= crop.max[0] && y >= crop.min[1] && y <= crop.max[1] && z >= crop.min[2] && z <= crop.max[2];
}

export function keepsPoint(crops: readonly CropLike[], x: number, y: number, z: number): boolean {
  return crops.every((crop) => insideBox(crop, x, y, z) === (crop.keep === 'inside'));
}

/** Indices of the points of the flat `[x, y, z, …]` array that survive `crops` (all of them when there are none). */
export function keptIndices(positions: ArrayLike<number>, crops: readonly CropLike[]): Uint32Array {
  const count = Math.floor(positions.length / 3);
  const kept = new Uint32Array(count);
  let n = 0;
  for (let i = 0; i < count; i++) {
    if (crops.length === 0 || keepsPoint(crops, positions[3 * i] ?? 0, positions[3 * i + 1] ?? 0, positions[3 * i + 2] ?? 0)) kept[n++] = i;
  }
  return kept.subarray(0, n);
}
