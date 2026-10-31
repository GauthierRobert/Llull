/**
 * Nozzle rows of the equipment that carries 03 EQP nozzles (plant 08 DAT M5): DN, rating and facing are the nozzle's; the connected line and the flow direction are read
 * from the process line objects (`from` / `to` naming `<tag>:<mark>`) and from the routed runs of 02 RTE that start or end at the nozzle port.
 */

import { elementsOf, getBuilding } from '@aec/building/model';
import type { CadDocument } from '@core/model/types';
import { getPiping } from '../../piping/model';
import { isProcessLine, lineEnds } from '../lines';
import { getPlantData, type PlantObject } from '../model';
import { objectRegistry } from '../registry';
import type { ReportRow } from './types';

interface Connection {
  readonly line: PlantObject;
  readonly flowDirection: 'SOURCE' | 'SINK';
}

/** Port id (`<equipment mark>:<nozzle mark>`) -> the first process line connected to it, by line `from` / `to` and by routed run ends. */
function connections(doc: CadDocument): ReadonlyMap<string, Connection> {
  const data = getPlantData(doc);
  const piping = getPiping(doc);
  const result = new Map<string, Connection>();
  const lineOfRoutedLine = new Map<string, PlantObject>();
  const lines: PlantObject[] = [];
  for (const id of data.objectOrder) {
    const object = data.objects[id];
    if (object === undefined || !isProcessLine(data, object)) continue;
    lines.push(object);
    if (object.target.kind === 'provider' && object.target.provider === 'pipeLine') lineOfRoutedLine.set(object.target.id, object);
  }
  const connect = (port: string, line: PlantObject, flowDirection: Connection['flowDirection']): void => {
    if (!result.has(port)) result.set(port, { line, flowDirection });
  };
  for (const line of lines) {
    const ends = lineEnds(doc, line);
    if (ends.from !== undefined) connect(ends.from, line, 'SOURCE');
    if (ends.to !== undefined) connect(ends.to, line, 'SINK');
  }
  const equipmentMarks = new Map(elementsOf(getBuilding(doc), 'equipment').map((equipment) => [equipment.id, equipment.mark]));
  for (const runId of piping.runOrder) {
    const run = piping.runs[runId];
    const line = run === undefined ? undefined : lineOfRoutedLine.get(run.lineId);
    if (run === undefined || line === undefined) continue;
    for (const [end, flow] of [
      [run.start, 'SOURCE'],
      [run.end, 'SINK'],
    ] as const)
      if (end.ref?.kind === 'nozzle') {
        const mark = equipmentMarks.get(end.ref.equipmentId);
        if (mark !== undefined) connect(`${mark}:${end.ref.nozzleId}`, line, flow);
      }
  }
  return result;
}

export function modelledNozzleRows(doc: CadDocument, inScope: ReadonlySet<string>, wholePlant: boolean): ReportRow[] {
  const equipment = elementsOf(getBuilding(doc), 'equipment').filter((element) => (element.plant?.nozzles.length ?? 0) > 0);
  if (equipment.length === 0) return [];
  const data = getPlantData(doc);
  const claimed = objectRegistry(data).byTarget;
  const connected = connections(doc);
  return equipment.flatMap((element) => {
    const object = data.objects[claimed.get(`buildingElement:${element.id}`) ?? ''];
    if (object === undefined ? !wholePlant : !inScope.has(object.id)) return [];
    const tag = object?.tag ?? element.mark;
    return (element.plant?.nozzles ?? []).map((nozzle): ReportRow => {
      const connection = connected.get(`${element.mark}:${nozzle.mark}`);
      return {
        key: `${tag}/${nozzle.mark}`,
        equipment: tag,
        nozzle: nozzle.mark,
        dn: nozzle.dn,
        rating: nozzle.rating,
        facing: nozzle.facing,
        flowDirection: connection?.flowDirection ?? null,
        line: connection?.line.tag ?? null,
        inferred: false,
        equipmentId: element.id,
        lineId: connection?.line.id ?? null,
      };
    });
  });
}
