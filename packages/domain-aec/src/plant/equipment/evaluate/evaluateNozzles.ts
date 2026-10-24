/** Derived geometry of equipment nozzles (plant 03 EQP): one revolution per nozzle, neck + flange, tagged to the equipment element. */

import type { Entity, RevolutionEntity, Vec3 } from '@core/model/types';
import type { BuildingLevel, EquipmentElement } from '@aec/building/types';
import { eulerFromAxes } from '@lib/eulerRotation';
import { cross3, normalize3OrZero } from '@lib/vec3';
import { base } from '../../../building/evaluate/entities';
import { placeNozzle, directionToWorld, toWorld } from '../geometry/ports';
import type { NozzleRecord } from '../plantData';

export const NOZZLE_COLOR = '#8f6a2f';
const NOZZLE_SEGMENTS = 32;

/** Euler angles taking local +Z onto the unit vector `direction`. */
export function rotationToward(direction: Vec3): Vec3 {
  const reference: Vec3 = Math.abs(direction[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x = normalize3OrZero(cross3(reference, direction));
  const y = cross3(direction, x);
  return eulerFromAxes(x, y, direction);
}

/** Neck (outside diameter, wall) and flange (outside diameter, thickness) as one L-shaped revolution section along the nozzle axis. */
function nozzleSection(nozzle: NozzleRecord, length: number): Array<[number, number]> {
  const outer = nozzle.neckOutsideDiameter / 2;
  const inner = Math.max(outer - nozzle.neckWall, outer * 0.2);
  const flangeRadius = nozzle.flange.outsideDiameter / 2;
  const shoulder = Math.max(length - nozzle.flange.thickness, 0);
  return [
    [inner, 0],
    [outer, 0],
    [outer, shoulder],
    [flangeRadius, shoulder],
    [flangeRadius, length],
    [inner, length],
  ];
}

/** One revolution entity per placeable nozzle of `element`, in nozzle order. */
export function evaluateNozzles(element: EquipmentElement, level: BuildingLevel): Entity[] {
  const plant = element.plant;
  if (plant === undefined) return [];
  return plant.nozzles.flatMap((nozzle): Entity[] => {
    const placement = placeNozzle(plant.template, nozzle);
    if (placement === null) return [];
    const length = Math.hypot(...placement.face.map((value, index) => value - (placement.base[index] as number)));
    if (length <= 0) return [];
    const section = nozzleSection(nozzle, length);
    const entity: RevolutionEntity = {
      ...base(
        element,
        { part: `nozzle-${nozzle.mark}`, label: `Nozzle ${element.mark}:${nozzle.mark} DN${nozzle.dn} ${nozzle.rating}` },
        toWorld(element, level, placement.base),
        rotationToward(directionToWorld(element, placement.direction)),
        NOZZLE_COLOR,
      ),
      kind: 'revolution',
      profile: section,
      axis: [0, 0, 1],
      angle: 2 * Math.PI,
      segments: NOZZLE_SEGMENTS,
    };
    return [entity];
  });
}
