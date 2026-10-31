/**
 * Nozzle schedule (plant 08 DAT §5.6 step 5, §5.9): the MVP has no nozzle objects, so a nozzle is inferred where the end of a process line lies inside
 * the footprint of the equipment its `from` / `to` names. Nozzles are numbered N1, N2 ... per equipment in the creation order of the lines (from end
 * first). Equipment that carries its own 03 EQP nozzles infers nothing (its nozzles are the M5 provider). Flow direction: the `from` end is a SOURCE
 * of the equipment, the `to` end a SINK.
 */

import { getBuilding } from '@aec/building/model';
import type { BuildingModel, EquipmentElement } from '@aec/building/types';
import { elementBoxes } from '@aec/industrial/clash/clashBoxes';
import type { CadDocument, Vec3 } from '@core/model/types';
import { fromMm } from '@core/model/units';
import { dot3, sub3 } from '@lib/vec3';
import { isProcessLine, lineEnds } from '../lines';
import { getPlantData, type PlantObject } from '../model';
import { naturalCompare } from '../naturalSort';
import { objectRegistry } from '../registry';
import { lineGeometries } from './lineGeometry';
import { columnOf, type ReportColumn, type ReportRow, type ReportTable } from './types';

const COLUMNS: readonly ReportColumn[] = [
  columnOf('key', 'Nozzle', 'text', null, 'derived'),
  columnOf('equipment', 'Equipment', 'text', null, 'derived'),
  columnOf('nozzle', 'Nozzle mark', 'text', null, 'derived'),
  columnOf('dn', 'DN', 'integer', null, 'geometry'),
  columnOf('rating', 'Rating', 'text', null, 'property'),
  columnOf('facing', 'Facing', 'text', null, 'property'),
  columnOf('flowDirection', 'Flow direction', 'text', null, 'derived'),
  columnOf('line', 'Line', 'text', null, 'derived'),
  columnOf('inferred', 'Inferred', 'boolean', null, 'derived'),
  columnOf('equipmentId', 'Equipment element', 'text', null, 'derived'),
  columnOf('lineId', 'Line object', 'text', null, 'derived'),
];

function insideEquipment(doc: CadDocument, building: BuildingModel, element: EquipmentElement, point: Vec3): boolean {
  const margin = fromMm(doc, 1);
  return elementBoxes(doc, building, element).some((box) => {
    const offset = sub3(point, box.center);
    return box.axes.every((axis, index) => Math.abs(dot3(offset, axis)) <= (box.half[index] as number) + margin);
  });
}

export function nozzleSchedule(doc: CadDocument, scoped: readonly PlantObject[]): ReportTable {
  const data = getPlantData(doc);
  const building = getBuilding(doc);
  const byMark = new Map<string, EquipmentElement>();
  for (const id of building.elementOrder) {
    const element = building.elements[id];
    if (element?.category === 'equipment' && !byMark.has(element.mark)) byMark.set(element.mark, element);
  }
  const claimed = objectRegistry(data).byTarget;
  const inScope = new Set(scoped.map((object) => object.id));
  const geometry = lineGeometries(doc);
  const counters = new Map<string, number>();
  const rows: ReportRow[] = [];
  for (const id of data.objectOrder) {
    const line = data.objects[id];
    if (line === undefined || !isProcessLine(data, line)) continue;
    const ends = lineEnds(doc, line);
    const shape = geometry.get(line.id);
    for (const [name, point, flowDirection] of [
      [ends.from, shape?.start, 'SOURCE'],
      [ends.to, shape?.end, 'SINK'],
    ] as const) {
      const equipment = name === undefined ? undefined : byMark.get(name);
      if (equipment === undefined || point === undefined || point === null) continue;
      if ((equipment.plant?.nozzles.length ?? 0) > 0 || !insideEquipment(doc, building, equipment, point)) continue;
      const count = (counters.get(equipment.id) ?? 0) + 1;
      counters.set(equipment.id, count);
      if (!inScope.has(line.id)) continue;
      const tag = data.objects[claimed.get(`buildingElement:${equipment.id}`) ?? '']?.tag ?? equipment.mark;
      const nozzle = `N${count}`;
      rows.push({
        key: `${tag}/${nozzle}`,
        equipment: tag,
        nozzle,
        dn: line.properties['nominalSize'] ?? shape?.dn ?? null,
        rating: null,
        facing: null,
        flowDirection,
        line: line.tag,
        inferred: true,
        equipmentId: equipment.id,
        lineId: line.id,
      });
    }
  }
  rows.sort(
    (a, b) => naturalCompare(String(a['equipment']), String(b['equipment'])) || naturalCompare(String(a['nozzle']), String(b['nozzle'])),
  );
  return { columns: COLUMNS, rows, keyColumn: 'key', method: 'inferred', totals: { nozzles: rows.length }, defaults: {} };
}
