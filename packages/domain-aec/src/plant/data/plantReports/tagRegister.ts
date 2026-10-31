/**
 * Tag register (plant 08 DAT §5.9): every tag of the objects in scope with class, hierarchy, the model object it stands for and its status. M5: when the report covers the
 * whole plant it also lists the tags of the 04 PID instruments no plant object stands for, `reserved` (the P&ID holds the tag; target kind `pidInstrument`).
 */

import type { CadDocument } from '@core/model/types';
import { pathOf } from '../hierarchy';
import { getPlantData, type PlantObject } from '../model';
import { elementOf, getProvider } from '../providers';
import { objectRegistry } from '../registry';
import { columnOf, type ReportColumn, type ReportRow, type ReportTable } from './types';

const COLUMNS: readonly ReportColumn[] = [
  columnOf('tag', 'Tag', 'text', null, 'derived'),
  columnOf('className', 'Class', 'text', null, 'derived'),
  columnOf('hierarchy', 'Hierarchy', 'text', null, 'derived'),
  columnOf('targetKind', 'Target kind', 'text', null, 'derived'),
  columnOf('target', 'Model object', 'text', null, 'derived'),
  columnOf('status', 'Status', 'text', null, 'derived'),
  columnOf('id', 'ObjectId', 'text', null, 'derived'),
];

export function tagRegister(doc: CadDocument, scoped: readonly PlantObject[], wholePlant: boolean): ReportTable {
  const data = getPlantData(doc);
  const counts = { modelled: 0, reserved: 0, orphan: 0 };
  const rows = scoped.map((object): ReportRow => {
    const model = object.target.kind === 'reserved' ? null : elementOf(doc, object.target);
    const status = object.target.kind === 'reserved' ? 'reserved' : model === null ? 'orphan' : 'modelled';
    counts[status] += 1;
    return {
      tag: object.tag,
      className: object.className,
      hierarchy: pathOf(data, object.hierarchyId),
      targetKind: object.target.kind === 'provider' ? object.target.provider : object.target.kind,
      target: model?.element.label ?? (object.target.kind === 'reserved' ? null : object.target.id),
      status,
      id: object.id,
    };
  });
  const claimed = objectRegistry(data).byTarget;
  for (const element of wholePlant ? (getProvider('pidInstrument')?.elements(doc) ?? []) : []) {
    if (claimed.has(`pidInstrument:${element.id}`)) continue;
    counts.reserved += 1;
    rows.push({
      tag: element.tag ?? null,
      className: null,
      hierarchy: null,
      targetKind: 'pidInstrument',
      target: element.label,
      status: 'reserved',
      id: null,
    });
  }
  return { columns: COLUMNS, rows, keyColumn: 'tag', method: 'none', totals: { tags: rows.length, ...counts }, defaults: {} };
}
