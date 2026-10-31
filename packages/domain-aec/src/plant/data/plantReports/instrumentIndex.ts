/**
 * Instrument index (plant 08 DAT §5.9, M5): one row per instrument of the 04 PID, with the plant object that stands for it (class, hierarchy) when one does. The
 * instruments are those of `doc.plant.pid` (the `pidInstrument` provider's objects); the ISA facts (functions, loop, location, display, sheet, measured line,
 * controlled valves) are the ones `pid_report instrument_index` lists. Instruments no plant object stands for are listed `unclassified` when the report covers the
 * whole plant.
 */

import type { CadDocument } from '@core/model/types';
import { instrumentEntries } from '../../pid/lists/instrumentIndex';
import { getPid } from '../../pid/state';
import { pathOf } from '../hierarchy';
import { getPlantData, type PlantObject } from '../model';
import { naturalCompare } from '../naturalSort';
import { elementOf } from '../providers';
import { objectRegistry } from '../registry';
import { columnOf, type ReportColumn, type ReportRow, type ReportTable } from './types';

const COLUMNS: readonly ReportColumn[] = [
  columnOf('tag', 'Tag', 'text', null, 'derived'),
  columnOf('className', 'Class', 'text', null, 'derived'),
  columnOf('hierarchy', 'Hierarchy', 'text', null, 'derived'),
  columnOf('category', 'Category', 'text', null, 'geometry'),
  columnOf('functions', 'Functions', 'text', null, 'geometry'),
  columnOf('loop', 'Loop', 'text', null, 'geometry'),
  columnOf('location', 'Location', 'text', null, 'geometry'),
  columnOf('display', 'Display', 'text', null, 'geometry'),
  columnOf('measuredLine', 'Measured line', 'text', null, 'geometry'),
  columnOf('controls', 'Controls', 'text', null, 'geometry'),
  columnOf('sheet', 'P&ID sheet', 'text', null, 'geometry'),
  columnOf('status', 'Status', 'text', null, 'derived'),
  columnOf('id', 'ObjectId', 'text', null, 'derived'),
  columnOf('element', 'Model object', 'text', null, 'derived'),
];

export function instrumentIndex(doc: CadDocument, scoped: readonly PlantObject[], wholePlant: boolean): ReportTable {
  const data = getPlantData(doc);
  const claimed = objectRegistry(data).byTarget;
  const inScope = new Set(scoped.map((object) => object.id));
  const rows: ReportRow[] = [];
  for (const { id, row } of instrumentEntries(getPid(doc))) {
    const objectId = claimed.get(`pidInstrument:${id}`);
    const object = objectId === undefined ? undefined : data.objects[objectId];
    if (object === undefined ? !wholePlant : !inScope.has(object.id)) continue;
    rows.push({
      ...row,
      tag: object?.tag ?? row['tag'] ?? null,
      className: object?.className ?? null,
      hierarchy: object === undefined ? null : pathOf(data, object.hierarchyId),
      status: object === undefined ? 'unclassified' : elementOf(doc, object.target) === null ? 'orphan' : 'modelled',
      id: object?.id ?? null,
      element: id,
    });
  }
  rows.sort((a, b) => naturalCompare(String(a['tag']), String(b['tag'])) || naturalCompare(String(a['element']), String(b['element'])));
  const count = (status: string): number => rows.filter((entry) => entry['status'] === status).length;
  return {
    columns: COLUMNS,
    rows,
    keyColumn: 'tag',
    method: 'none',
    totals: { instruments: rows.length, modelled: count('modelled'), unclassified: count('unclassified') },
    defaults: {},
  };
}
