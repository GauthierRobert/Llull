import type { Entity } from '../model/types';
import type { Bounds } from './bounds';
import { orientedEntityBounds } from './bounds';

/**
 * World-space AABB of one entity, with rotation applied when non-zero (`oriented:true` then marks the result). Zero rotation equals
 * `entityBounds`.
 * @affects nothing — read-only helper
 */
export function rotatedEntityBounds(e: Entity): Bounds {
  return orientedEntityBounds(e);
}
