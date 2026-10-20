/** Midsurface fast path of a box plate (05 §5.2 step 6): the mid rectangle across its thinnest side. */

import type { BoxEntity } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { entityLocalToWorld } from '@core/geometry/entityFrame';
import { applyEulerXYZ } from '@lib/eulerRotation';
import { ORIGIN } from '@lib/vec3';
import type { Midsurface, MidsurfaceOptions, MidsurfaceRefusal } from './types';

/**
 * Midsurface of a box whose smallest side is <= maxThickness and strictly smaller than the two others: one rectangle through the box centre,
 * normal along the thin local axis (rotated with the box).
 * @failure no side <= maxThickness, or two thin sides (a bar) -> FEA_MIDSURFACE_NOT_THIN / FEA_MIDSURFACE_NOT_A_PLATE
 */
export function boxPlateMidsurface(entity: BoxEntity, options: MidsurfaceOptions): Midsurface | MidsurfaceRefusal {
  const order = [0, 1, 2].sort((a, b) => (entity.size[a] ?? 0) - (entity.size[b] ?? 0));
  const thin = order[0] ?? 2;
  const thickness = entity.size[thin] ?? 0;
  if (!(thickness <= options.maxThickness))
    return {
      code: 'FEA_MIDSURFACE_NOT_THIN',
      message: `box '${entity.id}': its thinnest side ${thickness} exceeds maxThickness ${options.maxThickness}`,
    };
  const second = entity.size[order[1] ?? 1] ?? 0;
  if (second <= options.maxThickness || second <= thickness)
    return {
      code: 'FEA_MIDSURFACE_NOT_A_PLATE',
      message: `box '${entity.id}' has two sides <= maxThickness or no single thinnest side (${entity.size.join(' x ')}): a bar or a cube, not a plate`,
    };
  const i = (thin + 1) % 3;
  const j = (thin + 2) % 3;
  const half = (axis: number): number => (entity.size[axis] ?? 0) / 2;
  const corner = (si: number, sj: number): Vec3 => {
    const local: [number, number, number] = [0, 0, 0];
    local[i] = si * half(i);
    local[j] = sj * half(j);
    return entityLocalToWorld(entity, local);
  };
  const axis: [number, number, number] = [0, 0, 0];
  axis[thin] = 1;
  const normal = applyEulerXYZ(axis, ORIGIN, entity.rotation);
  return {
    entityId: entity.id,
    method: 'box_plate',
    faces: [{ outer: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], holes: [], normal, thickness, source: 'box' }],
    thicknesses: [thickness],
    coverage: 1,
    unpairedFaces: [],
    warnings: [],
  };
}
