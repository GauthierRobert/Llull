/**
 * Nozzles inferred from process line ends (plant 08 DAT §5.6 step 5, §5.9): where the first (`from`, SOURCE) or last (`to`, SINK) point of a line lies in the
 * oriented box of the equipment its end names (mark match, `elementBoxes` as `check_clashes`, 1 mm margin) the equipment gets a nozzle N1, N2 ... numbered per
 * equipment in the creation order of the lines (from end first) over the whole document. Equipment that carries its own 03 EQP nozzles infers none. Shared by the
 * nozzle schedule and the IFC ports so the two agree.
 * @invariant pure; same document, same nozzles in the same order
 */

import { getBuilding } from '@aec/building/model';
import type { BuildingModel, EquipmentElement } from '@aec/building/types';
import { elementBoxes } from '@aec/industrial/clash/clashBoxes';
import type { CadDocument, Vec3 } from '@core/model/types';
import { fromMm } from '@core/model/units';
import { dot3, sub3 } from '@lib/vec3';
import { isProcessLine, lineEnds } from '../lines';
import { getPlantData, type PlantObject } from '../model';
import { lineGeometries, type LineGeometry } from './lineGeometry';

export interface InferredNozzle {
  readonly equipment: EquipmentElement;
  /** `N1`, `N2` ... per equipment. */
  readonly name: string;
  readonly flowDirection: 'SOURCE' | 'SINK';
  readonly end: 'from' | 'to';
  readonly line: PlantObject;
  readonly shape: LineGeometry | undefined;
  /** World point of the line end (document units). */
  readonly point: Vec3;
}

function insideEquipment(doc: CadDocument, building: BuildingModel, element: EquipmentElement, point: Vec3): boolean {
  const margin = fromMm(doc, 1);
  return elementBoxes(doc, building, element).some((box) => {
    const offset = sub3(point, box.center);
    return box.axes.every((axis, index) => Math.abs(dot3(offset, axis)) <= (box.half[index] as number) + margin);
  });
}

export function inferredNozzles(doc: CadDocument): InferredNozzle[] {
  const data = getPlantData(doc);
  const building = getBuilding(doc);
  const byMark = new Map<string, EquipmentElement>();
  for (const id of building.elementOrder) {
    const element = building.elements[id];
    if (element?.category === 'equipment' && !byMark.has(element.mark)) byMark.set(element.mark, element);
  }
  const geometry = lineGeometries(doc);
  const counters = new Map<string, number>();
  const nozzles: InferredNozzle[] = [];
  for (const id of data.objectOrder) {
    const line = data.objects[id];
    if (line === undefined || !isProcessLine(data, line)) continue;
    const ends = lineEnds(doc, line);
    const shape = geometry.get(line.id);
    for (const [end, name, point, flowDirection] of [
      ['from', ends.from, shape?.start, 'SOURCE'],
      ['to', ends.to, shape?.end, 'SINK'],
    ] as const) {
      const equipment = name === undefined ? undefined : byMark.get(name);
      if (equipment === undefined || point === undefined || point === null) continue;
      if ((equipment.plant?.nozzles.length ?? 0) > 0 || !insideEquipment(doc, building, equipment, point)) continue;
      const count = (counters.get(equipment.id) ?? 0) + 1;
      counters.set(equipment.id, count);
      nozzles.push({ equipment, name: `N${count}`, flowDirection, end, line, shape, point });
    }
  }
  return nozzles;
}
