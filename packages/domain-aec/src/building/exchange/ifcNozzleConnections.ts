/**
 * Connections of drawn process-line ends to the real 03 EQP nozzle ports (plant 08 DAT H6): a pipe end of a classified line meets the nozzle port of the
 * equipment its `from` / `to` names (`<tag>:<mark>`), else the nozzle whose face lies within 1 mm of the pipe end. One IfcRelConnectsPorts per end, the SOURCE as
 * RelatingPort (the nozzle for a `from` end, the pipe end for a `to` end), as the inferred nozzles do. Routed runs are connected by `ifcPipingExport`.
 * @invariant pure; a port already connected, or a nozzle already used, is left alone (one connection per port)
 */

import type { CadDocument } from '@core/model/types';
import { fromMm } from '@core/model/units';
import { len3, sub3 } from '@lib/vec3';
import { elementsOf, getBuilding } from '@aec/building/model';
import { equipmentPorts } from '../../plant/equipment/geometry/ports';
import { lineEnds } from '../../plant/data/lines';
import { getPlantData } from '../../plant/data/model';
import { connect, type Port, type PortState } from './ifcPorts';
import type { Context } from './ifcStep';

/** Number of connections written. */
export function connectRealNozzles(context: Context, doc: CadDocument, state: PortState): number {
  if (state.nozzlePorts.size === 0) return 0;
  const data = getPlantData(doc);
  const building = getBuilding(doc);
  const equipment = elementsOf(building, 'equipment').filter((element) => state.nozzlePorts.has(element.id));
  const margin = fromMm(doc, 1);
  const used = new Set<string>();
  let count = 0;
  for (const end of state.endPorts) {
    const line = end.lineId === null ? undefined : data.objects[end.lineId];
    if (line === undefined || state.connected.has(end.ref)) continue;
    const named = (end.end === 'start' ? lineEnds(doc, line).from : lineEnds(doc, line).to)?.split(/:(?=[^:]*$)/);
    let nozzle: Port | undefined;
    const owner = named === undefined ? undefined : equipment.find((element) => element.mark === named[0]);
    if (owner !== undefined && named?.[1] !== undefined) nozzle = state.nozzlePorts.get(owner.id)?.get(named[1]);
    if (nozzle === undefined)
      for (const element of equipment) {
        const near = equipmentPorts(building, element).find((port) => len3(sub3(port.position, end.world)) <= margin);
        if (near !== undefined) nozzle = state.nozzlePorts.get(element.id)?.get(near.mark);
        if (nozzle !== undefined) break;
      }
    if (nozzle === undefined || used.has(nozzle.ref) || state.connected.has(nozzle.ref)) continue;
    used.add(nozzle.ref);
    if (end.end === 'start') connect(context, state, nozzle, end);
    else connect(context, state, end, nozzle);
    count += 1;
  }
  return count;
}
