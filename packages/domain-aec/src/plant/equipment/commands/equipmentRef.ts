/** Addressing of equipment by tag or element id, and the pipes attached to a port. */

import type { BuildingModel, EquipmentElement } from '@aec/building/types';
import { z } from '@core/commands/schema';
import { elementsOf } from '../../../building/model';

export const equipmentRefParam = z
  .string()
  .min(1)
  .describe('Equipment tag (e.g. "V-101", the element mark) or element id (e.g. "equipment-3").');

/** The equipment whose element id or tag (mark) is `reference`; id wins over tag. */
export function findEquipment(building: BuildingModel, reference: string): EquipmentElement | undefined {
  const byId = building.elements[reference];
  if (byId?.category === 'equipment') return byId;
  return elementsOf(building, 'equipment').find((element) => element.mark === reference);
}

/** Pipe elements whose `from` / `to` names the port id `<tag>:<mark>` (the line-list reference of a pipe to a nozzle). */
export function connectedPipeIds(building: BuildingModel, portId: string): string[] {
  return elementsOf(building, 'pipe')
    .filter((pipe) => pipe.from === portId || pipe.to === portId)
    .map((pipe) => pipe.id);
}
