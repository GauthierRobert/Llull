// Pure pose of the cylinder that draws one straight segment (the unit cylinder of three.js runs along +Y, height 1).

import type { Vec3 } from '@core/model/types';

export interface SegmentPose {
  readonly center: Vec3;
  readonly length: number;
  /** Quaternion [x, y, z, w] taking +Y to the segment direction. */
  readonly quaternion: [number, number, number, number];
}

/** Pose of the cylinder between `a` and `b`; null for a zero-length segment. */
export function segmentPose(a: Vec3, b: Vec3): SegmentPose | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-9) return null;
  const [ux, uy, uz] = [dx / length, dy / length, dz / length];
  const center: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  if (uy < -1 + 1e-9) return { center, length, quaternion: [1, 0, 0, 0] };
  const w = 1 + uy;
  const norm = Math.hypot(uz, ux, w);
  return { center, length, quaternion: [uz / norm, 0, -ux / norm, w / norm] };
}
