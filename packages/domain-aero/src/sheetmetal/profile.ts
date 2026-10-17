/** Reads a drawn 2D entity as a closed planar loop with the frame of its work plane. */

import { is2D, type Entity, type Vec2 } from '@core/model/types';
import type { Frame3 } from '@core/model/sheetMetal';
import { applyEulerXYZ } from '@lib/eulerRotation';
import { ORIGIN } from '@lib/vec3';
import { toCounterClockwise } from '@lib/polygon';
import { circlePolygon, isSimplePolygon } from './geometry2d';

export interface ProfileLoop {
  /** Counter-clockwise points in the entity's local plane coordinates. */
  readonly points: Vec2[];
  readonly frame: Frame3;
  readonly circle?: { readonly center: Vec2; readonly radius: number };
}

/** Frame of a 2D entity's work plane: origin at `position`, x and normal rotated by `rotation`. */
export function entityFrame(entity: Pick<Entity, 'position' | 'rotation'>): Frame3 {
  return {
    origin: entity.position,
    xDir: applyEulerXYZ([1, 0, 0], ORIGIN, entity.rotation),
    normal: applyEulerXYZ([0, 0, 1], ORIGIN, entity.rotation),
  };
}

/**
 * Closed loop of a rectangle, closed polyline or circle (a 64-gon with its exact circle kept).
 * @failure any other kind, an open or self-intersecting polyline -> a reason string
 */
export function readProfile(entity: Entity): ProfileLoop | string {
  if (!is2D(entity)) return `entity ${entity.id} is a ${entity.kind}, not a 2D profile`;
  const frame = entityFrame(entity);
  switch (entity.kind) {
    case 'rectangle': {
      const { width, height } = entity;
      const points: Vec2[] = [
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
      ];
      return width > 0 && height > 0 ? { points, frame } : `rectangle ${entity.id} has no area`;
    }
    case 'circle':
      return entity.radius > 0
        ? { points: circlePolygon(entity.center, entity.radius), frame, circle: { center: entity.center, radius: entity.radius } }
        : `circle ${entity.id} has no area`;
    case 'polyline': {
      if (!entity.closed) return `polyline ${entity.id} is open`;
      const points = toCounterClockwise(entity.points);
      return isSimplePolygon(points) ? { points, frame } : `polyline ${entity.id} is degenerate or self-intersecting`;
    }
    default:
      return `entity ${entity.id} is a ${entity.kind}; use a rectangle, closed polyline or circle`;
  }
}
