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

/** Slack around the scene sphere so its surfaces never touch the clip planes. */
const RANGE_SLACK = 1.05;

/** Near/far hugging the scene's bounding sphere as seen from the camera. The view camera's range (adaptive, ~1:4e6) leaves a 24-bit depth
 *  buffer ~1e-4 of the distance per step, which GTAO turns into banding on flat faces; the AO pass renders with this tighter range instead.
 *  Falls back to the camera's own range when the camera is inside the sphere or the sphere is degenerate. */
export function tightDepthRange(distanceToCentre: number, radius: number, cameraNear: number, cameraFar: number): DepthRange {
  const near = distanceToCentre - radius * RANGE_SLACK;
  const far = distanceToCentre + radius * RANGE_SLACK;
  if (!(radius > 0) || !Number.isFinite(near) || !Number.isFinite(far) || near <= cameraNear || far <= near)
    return { near: cameraNear, far: cameraFar };
  return { near, far: Math.min(far, cameraFar) };
}
