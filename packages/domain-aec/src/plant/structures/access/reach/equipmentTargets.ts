/** Operating points of the equipment nozzles and manways (03 EQP): the flange face centre of each nozzle (`equipmentPorts`), tagged by its port id `<equipment mark>:<nozzle mark>`. */

import type { CadDocument } from '@core/model/types';
import { MM_PER_UNIT } from '@core/model/units';
import { elementsOf, getBuilding } from '@aec/building/model';
import { equipmentPorts } from '../../../equipment/geometry/ports';
import type { ReachTarget } from './valveTargets';

/** A manway is a nozzle whose service names one (the equipment model has no manway type: `service: "manway"`). */
const MANWAY = /manway/i;

/** `nozzles` = every nozzle that is not a manway (kind `equipment_nozzle`); `manways` = the nozzles whose service names a manway (kind `manway`). Points in millimetres. */
export function equipmentTargets(doc: CadDocument, kinds: ReadonlySet<'nozzles' | 'manways'>): ReachTarget[] {
  const factor = MM_PER_UNIT[doc.units];
  const targets: ReachTarget[] = [];
  for (const element of elementsOf(getBuilding(doc), 'equipment')) {
    for (const port of equipmentPorts(doc, element)) {
      const manway = port.service !== undefined && MANWAY.test(port.service);
      if (!kinds.has(manway ? 'manways' : 'nozzles')) continue;
      targets.push({
        tag: port.id,
        kind: manway ? 'manway' : 'equipment_nozzle',
        pointMm: [port.position[0] * factor, port.position[1] * factor, port.position[2] * factor],
        source: manway ? 'manways' : 'nozzles',
        ref: element.id,
      });
    }
  }
  return targets;
}
