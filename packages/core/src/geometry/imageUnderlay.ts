/**
 * Image-underlay placement math: image pixel ⇄ work-plane local ⇄ world, and the two-point
 * calibration that turns a measured pixel segment into a scale (plus optional origin and
 * axis alignment).
 *
 * Pixel space: origin at the image's TOP-left corner, +x right, +y DOWN (how image viewers and
 * agents reading a picture count pixels). Local space: the entity's work plane, origin at the
 * image's lower-left corner, +y up. World: local rotated by the entity's Euler rotation (three.js
 * XYZ, so rotation[2] is the in-plane angle) about `position`, then offset by `position`.
 *
 * @layer geometry
 * @pure
 */

import type { ImageEntity, Vec2, Vec3 } from '../model/types';
import { applyEulerXYZ } from '../lib/eulerRotation';
import { sub3 } from '../lib/vec3';
import { wrapSignedAngle } from '../lib/angle';
import { planeToWorld } from './workPlane';

export type UnderlayPlacement = Pick<ImageEntity, 'position' | 'rotation' | 'width' | 'height' | 'pixelWidth' | 'pixelHeight'>;

/** Work-plane local [x, y] of image pixel `pixel`. */
export function pixelToLocal(placement: UnderlayPlacement, pixel: Vec2): Vec2 {
  const { width, height, pixelWidth, pixelHeight } = placement;
  return [(pixel[0] * width) / pixelWidth, height - (pixel[1] * height) / pixelHeight];
}

/** `local` (work-plane [x, y]) rotated by `rotation`; the offset from the entity origin. */
function rotatedOffset(rotation: Vec3, local: Vec2): Vec3 {
  return applyEulerXYZ([local[0], local[1], 0], [0, 0, 0], rotation);
}

/** World point of image pixel `pixel`. */
export function pixelToWorld(placement: UnderlayPlacement, pixel: Vec2): Vec3 {
  return planeToWorld(placement.position, placement.rotation, pixelToLocal(placement, pixel));
}

/** World corners of the image: top-left, top-right, bottom-right, bottom-left (pixel order). */
export function underlayCorners(placement: UnderlayPlacement): [Vec3, Vec3, Vec3, Vec3] {
  const { pixelWidth: w, pixelHeight: h } = placement;
  const at = (pixel: Vec2): Vec3 => pixelToWorld(placement, pixel);
  return [at([0, 0]), at([w, 0]), at([w, h]), at([0, h])];
}

type UnderlayAxis = 'x' | 'y';

export interface UnderlayCalibration {
  /** Two image pixels whose real-world separation is known. */
  readonly pixelA: Vec2;
  readonly pixelB: Vec2;
  /** Real distance between them, in document units (> 0). */
  readonly distance: number;
  /** Pin `pixel` to `world`; default: pixelA keeps its current world position. */
  readonly origin?: { readonly pixel: Vec2; readonly world: Vec3 };
  /** Rotate in-plane (smallest turn) so A→B runs along this work-plane axis. */
  readonly align?: UnderlayAxis;
}

export type CalibrationResult =
  | {
      readonly ok: true;
      readonly placement: UnderlayPlacement;
      /** Document units per image pixel. */
      readonly unitsPerPixel: number;
      /** Pixel distance |B − A|. */
      readonly pixelDistance: number;
    }
  | { readonly ok: false; readonly error: string };

/**
 * `angle` wrapped into [−π/2, π/2]: an axis is aligned in either direction, so turn the least; an
 * exact quarter turn keeps the sign that points the segment along the positive axis.
 */
function smallestAxisTurn(angle: number): number {
  const wrapped = wrapSignedAngle(angle);
  const quarter = Math.PI / 2 + 1e-12;
  if (wrapped > quarter) return wrapped - Math.PI;
  if (wrapped < -quarter) return wrapped + Math.PI;
  return wrapped;
}

/**
 * New placement after a two-point calibration: uniform scale `distance / |B − A|` units per pixel,
 * optional in-plane alignment of A→B with a local axis, then a translation pinning the anchor pixel.
 * @failure distance not finite/> 0, or A and B the same pixel -> { ok: false }
 */
export function calibrateUnderlay(placement: UnderlayPlacement, calibration: UnderlayCalibration): CalibrationResult {
  const { pixelA, pixelB, distance, origin, align } = calibration;
  if (!Number.isFinite(distance) || distance <= 0) return { ok: false, error: `distance must be a finite number > 0 (got ${distance})` };
  const dx = pixelB[0] - pixelA[0];
  const dy = pixelB[1] - pixelA[1];
  const pixelDistance = Math.hypot(dx, dy);
  if (!(pixelDistance > 0)) return { ok: false, error: 'pixelA and pixelB must be two different pixels' };

  const unitsPerPixel = distance / pixelDistance;
  // Pixel +y is down, so the segment's in-plane angle (before rotation) is atan2(-dy, dx).
  const segmentAngle = Math.atan2(-dy, dx);
  const [rx, ry, rz] = placement.rotation;
  const inPlane = align === undefined ? rz : smallestAxisTurn((align === 'x' ? 0 : Math.PI / 2) - segmentAngle) + 0;
  const scaled = {
    ...placement,
    rotation: [rx, ry, inPlane] as Vec3,
    width: placement.pixelWidth * unitsPerPixel,
    height: placement.pixelHeight * unitsPerPixel,
  };
  const anchorPixel = origin?.pixel ?? pixelA;
  const anchorWorld = origin?.world ?? pixelToWorld(placement, anchorPixel);
  const offset = rotatedOffset(scaled.rotation, pixelToLocal(scaled, anchorPixel));
  return {
    ok: true,
    placement: { ...scaled, position: sub3(anchorWorld, offset) },
    unitsPerPixel,
    pixelDistance,
  };
}
