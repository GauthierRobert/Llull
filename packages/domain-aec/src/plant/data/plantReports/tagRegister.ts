/** Tag register (plant 08 DAT §5.9): every tag of the objects in scope with class, hierarchy, the model object it stands for and its status. */

import type { CadDocument } from '@core/model/types';
import { pathOf } from '../hierarchy';
import { getPlantData, type PlantObject } from '../model';
import { elementOf } from '../providers';
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

export function tagRegister(doc: CadDocument, scoped: readonly PlantObject[]): ReportTable {
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
  return { columns: COLUMNS, rows, keyColumn: 'tag', method: 'none', totals: { tags: rows.length, ...counts }, defaults: {} };
}
