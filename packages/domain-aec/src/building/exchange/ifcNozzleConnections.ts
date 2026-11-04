/**
 * Connections of drawn process-line ends to the real 03 EQP nozzle ports (plant 08 DAT H6): a pipe end of a classified line meets the nozzle port of the
 * equipment its `from` / `to` names (`<tag>:<mark>`), else the nozzle whose face lies within 1 mm of the pipe end. One IfcRelConnectsPorts per end, the SOURCE as
 * RelatingPort (the nozzle for a `from` end, the pipe end for a `to` end), as the inferred nozzles do. Routed runs are connected by `ifcPipingExport`.
 * @invariant pure; a port already connected, or a nozzle already used, is left alone (one connection per port; a named owner is never second-guessed by proximity; among nozzles within 1 mm the nearest wins, ties by element id and mark)
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
    const free = (port: Port | undefined): Port | undefined =>
      port === undefined || used.has(port.ref) || state.connected.has(port.ref) ? undefined : port;
    const owner = named === undefined ? undefined : equipment.find((element) => element.mark === named[0]);
    let nozzle: Port | undefined;
    if (owner !== undefined) nozzle = free(state.nozzlePorts.get(owner.id)?.get(named?.[1] ?? ''));
    else {
      let best: { port: Port; distance: number; key: string } | undefined;
      for (const element of equipment)
        for (const port of equipmentPorts(building, element)) {
          const candidate = free(state.nozzlePorts.get(element.id)?.get(port.mark));
          const distance = len3(sub3(port.position, end.world));
          const key = `${element.id}:${port.mark}`;
          if (
            candidate !== undefined &&
            distance <= margin &&
            (best === undefined || distance < best.distance || (distance === best.distance && key < best.key))
          )
            best = { port: candidate, distance, key };
        }
      nozzle = best?.port;
    }
    if (nozzle === undefined) continue;
    used.add(nozzle.ref);
    if (end.end === 'start') connect(context, state, nozzle, end);
    else connect(context, state, end, nozzle);
    count += 1;
  }
  return count;
}
