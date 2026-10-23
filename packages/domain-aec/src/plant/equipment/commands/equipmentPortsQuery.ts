import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { elementsOf, getBuilding } from '../../../building/model';
import { equipmentPorts } from '../geometry/ports';
import { refuse } from '../model';
import { angleConventionParam, type AngleConvention } from './angles';
import { equipmentRefParam, findEquipment } from './equipmentRef';
import { orientationIn } from './nozzleParams';

/** Output bound (AF-12): without `equipment` the answer lists at most this many ports. */
const PORT_LIMIT = 500;

/**
 * @affects none (query: returns the same document; results in `data`)
 * @invariant ports are computed from the stored template and nozzles (never stored): world position of the flange face centre, unit direction
 *   pointing away from the equipment, id `<tag>:<mark>`; document order of the equipment, then nozzle order
 * @failure unknown equipment -> EQP_NOT_FOUND
 */
export const equipmentPortsQuery = defineCommand({
  name: 'equipment_ports',
  description:
    'Query: the connection ports of one equipment (tag or id) or of all equipment: for every nozzle, id "<tag>:<mark>", world position of the flange ' +
    'face centre and unit direction pointing away from the equipment (document units, level elevation included), DN, rating, facing, service, ' +
    'orientationDeg in the chosen angleConvention, and the flange (outsideDiameter, thickness, placeholder, catalogRef). `ports` is keyed by port id ' +
    '(also listed in `order`). Without `equipment` at most 500 ports are returned (truncated says so). Routing connects pipes to these ports. ' +
    'Refusal: EQP_NOT_FOUND. Does not modify the document.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({ equipment: equipmentRefParam.optional(), angleConvention: angleConventionParam }),
  run: (doc, { equipment, angleConvention }): CommandResult => {
    const building = getBuilding(doc);
    const convention: AngleConvention = angleConvention ?? 'north_cw';
    const scope =
      equipment === undefined ? elementsOf(building, 'equipment') : [findEquipment(building, equipment)].flatMap((found) => found ?? []);
    if (equipment !== undefined && scope.length === 0)
      return refuse(doc, 'equipment_ports', 'EQP_NOT_FOUND', `no equipment with tag or id '${equipment}'`, [], ['equipment']);
    const ports: Record<string, unknown> = {};
    const order: string[] = [];
    let total = 0;
    for (const element of scope) {
      for (const port of equipmentPorts(building, element)) {
        total += 1;
        if (equipment === undefined && order.length >= PORT_LIMIT) continue;
        const nozzle = element.plant?.nozzles.find((candidate) => candidate.mark === port.mark);
        order.push(port.id);
        ports[port.id] = {
          ...port,
          ...(nozzle === undefined ? {} : { orientationDeg: orientationIn(nozzle.location, convention) ?? null, flange: nozzle.flange }),
        };
      }
    }
    return report(doc, `equipment_ports: ${total} port(s) on ${scope.length} equipment (angleConvention ${convention}).`, {
      ports,
      order,
      count: total,
      truncated: total > order.length,
      angleConvention: convention,
    });
  },
});
