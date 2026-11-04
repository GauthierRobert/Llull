// Pure settings of the ambient-occlusion pass (GTAO, three's addon): half-resolution target size and the world-space AO parameters.

/** GTAO runs at this fraction of the frame size per axis; the blend samples it back with linear filtering. */
const GTAO_RESOLUTION_SCALE = 0.5;
/** Largest AO reach in millimetres: contact darkening in corners and under shelves, not a room-wide gradient. */
export const GTAO_MAX_RADIUS_MM = 1000;
/** The reach is this fraction of the scene's diagonal, so a 2 mm part and a 200 m plant both get contact shadows at their own scale. */
const RADIUS_PER_DIAGONAL = 0.06;

export function gtaoSize(width: number, height: number): { readonly width: number; readonly height: number } {
  return { width: Math.max(1, Math.ceil(width * GTAO_RESOLUTION_SCALE)), height: Math.max(1, Math.ceil(height * GTAO_RESOLUTION_SCALE)) };
}

export interface GtaoParameters {
  readonly radius: number;
  readonly distanceExponent: number;
  readonly thickness: number;
  readonly scale: number;
  readonly samples: number;
  readonly distanceFallOff: number;
  readonly screenSpaceRadius: boolean;
}

/** AO reach in document units: a fraction of the scene diagonal, capped at `maxRadius` (empty scene: the cap). */
export function gtaoRadius(diagonal: number | null, maxRadius: number): number {
  if (diagonal === null || !Number.isFinite(diagonal) || diagonal <= 0) return maxRadius;
  return Math.min(maxRadius, diagonal * RADIUS_PER_DIAGONAL);
}

/** `radius` in document units. The thickness keeps thin objects (pipes, rails) from over-occluding what is behind them. */
export function gtaoParameters(radius: number): GtaoParameters {
  return { radius, distanceExponent: 1, thickness: radius * 0.4, scale: 1, samples: 12, distanceFallOff: 1, screenSpaceRadius: false };
}

export interface DepthRange {
  readonly near: number;
  readonly far: number;
}

/** Slack around the scene's depth extent so its surfaces never touch the clip planes. */
const RANGE_SLACK = 1.05;
/** Near is never below far x this (the AO and edge passes then miss surfaces closer than that to the eye). */
const MIN_NEAR_OF_FAR = 1e-4;

type Vector = readonly [number, number, number];

/** Near/far hugging the scene's bounding box along the view direction (depth of its 8 corners), so it also works from inside the scene (the
 *  walk case), where near falls back to far x 1e-4 instead of the view camera's near. Falls back to the camera's own range when the box is
 *  entirely behind the camera or degenerate. */
export function viewDepthRange(eye: Vector, forward: Vector, min: Vector, max: Vector, cameraNear: number, cameraFar: number): DepthRange {
  let nearest = Number.POSITIVE_INFINITY;
  let farthest = Number.NEGATIVE_INFINITY;
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        const depth = (x - eye[0]) * forward[0] + (y - eye[1]) * forward[1] + (z - eye[2]) * forward[2];
        nearest = Math.min(nearest, depth);
        farthest = Math.max(farthest, depth);
      }
    }
  }
  if (!Number.isFinite(nearest) || !Number.isFinite(farthest) || farthest <= 0) return { near: cameraNear, far: cameraFar };
  const far = Math.min(farthest * RANGE_SLACK, cameraFar);
  const near = Math.max(cameraNear, nearest > 0 ? nearest / RANGE_SLACK : 0, far * MIN_NEAR_OF_FAR);
  return near < far ? { near, far } : { near: cameraNear, far: cameraFar };
}
