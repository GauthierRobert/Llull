// Pure geometry of the stress overlay: the centreline of a building pipe in absolute document coordinates, and the pose of the cylinder that
// draws one straight segment of it (the unit cylinder of three.js runs along +Y, height 1).

import type { CadDocument, Vec3 } from '@core/model/types';

export interface PipePath {
  readonly pipeId: string;
  readonly points: readonly Vec3[];
  /** Outside diameter, mm. */
  readonly odMm: number;
}

/**
 * The centreline of building pipe `pipeId` (point z is relative to its level), or null when the id is not a building pipe: 02 RTE runs derive
 * their centreline inside the plugin and no read-only query exposes it yet, so the overlay cannot draw them.
 */
export function pipePath(document: CadDocument, pipeId: string): PipePath | null {
  const building = document.building;
  const element = building !== undefined && Object.hasOwn(building.elements, pipeId) ? building.elements[pipeId] : undefined;
  if (element?.category !== 'pipe' || element.points.length < 2) return null;
  const elevation = building?.levels[element.levelId]?.elevation ?? 0;
  return {
    pipeId,
    points: element.points.map((point): Vec3 => [point[0], point[1], point[2] + elevation]),
    odMm: element.spec?.odMm ?? element.diameter,
  };
}

/** The point at half the length of the path (where the panel's beacon sits). */
export function pathMidpoint(points: readonly Vec3[]): Vec3 | null {
  if (points.length === 0) return null;
  const lengths = points.slice(1).map((point, i) => Math.hypot(...sub(point, points[i] as Vec3)));
  let remaining = lengths.reduce((a, b) => a + b, 0) / 2;
  for (const [i, length] of lengths.entries()) {
    const a = points[i] as Vec3;
    const b = points[i + 1] as Vec3;
    if (remaining <= length && length > 0) {
      const t = remaining / length;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    remaining -= length;
  }
  return points[points.length - 1] as Vec3;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export interface SegmentPose {
  readonly center: Vec3;
  readonly length: number;
  /** Quaternion [x, y, z, w] taking +Y to the segment direction. */
  readonly quaternion: [number, number, number, number];
}

/** Pose of the cylinder between `a` and `b`; null for a zero-length segment. */
export function segmentPose(a: Vec3, b: Vec3): SegmentPose | null {
  const [dx, dy, dz] = sub(b, a);
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-9) return null;
  const [ux, uy, uz] = [dx / length, dy / length, dz / length];
  const center: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  if (uy < -1 + 1e-9) return { center, length, quaternion: [1, 0, 0, 0] };
  const w = 1 + uy;
  const norm = Math.hypot(uz, ux, w);
  return { center, length, quaternion: [uz / norm, 0, -ux / norm, w / norm] };
}
