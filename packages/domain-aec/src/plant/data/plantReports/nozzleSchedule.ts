/**
 * Nozzle schedule (plant 08 DAT §5.6 step 5, §5.9): one row per nozzle. An equipment that carries 03 EQP nozzles lists them as modelled (DN, rating and facing of the
 * nozzle, `inferred` false; M5); the flow direction and the line come from the process line whose `from` / `to` names the port `<tag>:<mark>` (from end = SOURCE, to end =
 * SINK) or from the routed run that starts / ends at it. For any other equipment a nozzle is inferred where the end of a process line lies inside the footprint of the
 * equipment its `from` / `to` names (`inferNozzles.ts`, shared with the IFC ports), numbered N1, N2 ... per equipment in the creation order of the lines (from end first).
 */

import type { CadDocument } from '@core/model/types';
import { getPlantData, type PlantObject } from '../model';
import { naturalCompare } from '../naturalSort';
import { objectRegistry } from '../registry';
import { inferredNozzles } from './inferNozzles';
import { modelledNozzleRows } from './modelledNozzles';
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

export function nozzleSchedule(doc: CadDocument, scoped: readonly PlantObject[], wholePlant: boolean): ReportTable {
  const data = getPlantData(doc);
  const claimed = objectRegistry(data).byTarget;
  const inScope = new Set(scoped.map((object) => object.id));
  const rows: ReportRow[] = modelledNozzleRows(doc, inScope, wholePlant);
  for (const { equipment, name: nozzle, flowDirection, line, shape } of inferredNozzles(doc)) {
    if (!inScope.has(line.id)) continue;
    const tag = data.objects[claimed.get(`buildingElement:${equipment.id}`) ?? '']?.tag ?? equipment.mark;
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
  rows.sort(
    (a, b) => naturalCompare(String(a['equipment']), String(b['equipment'])) || naturalCompare(String(a['nozzle']), String(b['nozzle'])),
  );
  const method = rows.some((row) => row['inferred'] === true) || rows.length === 0 ? 'inferred' : 'model';
  return { columns: COLUMNS, rows, keyColumn: 'key', method, totals: { nozzles: rows.length }, defaults: {} };
}
