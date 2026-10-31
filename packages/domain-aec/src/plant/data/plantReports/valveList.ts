/**
 * Valve list (plant 08 DAT §5.9, M5): one row per valve. A valve is a plant object of the `Valve` class family (or a class mapped to IfcValve), standing for a valve
 * of a routed run of 02 RTE (the `inlineComponent` provider) or reserved; its size, face-to-face length, line and spec are read from the derived run. Valves of the
 * runs that no plant object stands for are listed `unclassified` when the report covers the whole plant (they have no hierarchy node to be in scope of).
 */

import type { CadDocument } from '@core/model/types';
import { resolvedOrNull } from '../classes';
import { pathOf } from '../hierarchy';
import { inlineInfos, isValveType, type InlineInfo } from '../inlineInfo';
import { getPlantData, type PlantObject } from '../model';
import { naturalCompare } from '../naturalSort';
import { elementOf } from '../providers';
import { objectRegistry } from '../registry';
import { columnOf, round6, type ReportColumn, type ReportRow, type ReportTable } from './types';

const VALVE_CLASS = 'Valve';
const VALVE_IFC_ENTITY = 'IfcValve';

const COLUMNS: readonly ReportColumn[] = [
  columnOf('tag', 'Tag', 'text', null, 'derived'),
  columnOf('className', 'Class', 'text', null, 'derived'),
  columnOf('hierarchy', 'Hierarchy', 'text', null, 'derived'),
  columnOf('componentType', 'Component type', 'text', null, 'geometry'),
  columnOf('dn', 'DN', 'integer', null, 'geometry'),
  columnOf('lengthMm', 'Face to face', 'real', 'mm', 'geometry'),
  columnOf('spec', 'Spec', 'text', null, 'geometry'),
  columnOf('line', 'Line', 'text', null, 'geometry'),
  columnOf('run', 'Run', 'text', null, 'geometry'),
  columnOf('status', 'Status', 'text', null, 'derived'),
  columnOf('unverified', 'Unverified', 'boolean', null, 'derived'),
  columnOf('id', 'ObjectId', 'text', null, 'derived'),
  columnOf('element', 'Model object', 'text', null, 'derived'),
];

function isValveObject(doc: CadDocument, object: PlantObject): boolean {
  const resolved = resolvedOrNull(getPlantData(doc), object.className);
  return resolved !== null && (resolved.chain.includes(VALVE_CLASS) || resolved.ifc?.entity === VALVE_IFC_ENTITY);
}

function row(fields: Readonly<Record<string, ReportRow[string]>>, info: InlineInfo | undefined): ReportRow {
  return {
    tag: null,
    className: null,
    hierarchy: null,
    componentType: info?.component.type ?? null,
    dn: info?.dn ?? null,
    lengthMm: info?.lengthMm == null ? null : round6(info.lengthMm),
    spec: info?.spec ?? null,
    line: info?.lineNumber ?? null,
    run: info?.run.id ?? null,
    status: 'unclassified',
    unverified: info?.unverified ?? false,
    id: null,
    element: info?.component.id ?? null,
    ...fields,
  };
}

export function valveList(doc: CadDocument, scoped: readonly PlantObject[], wholePlant: boolean): ReportTable {
  const data = getPlantData(doc);
  const infos = new Map(inlineInfos(doc).map((info) => [info.component.id, info]));
  const rows: ReportRow[] = [];
  for (const object of scoped) {
    if (!isValveObject(doc, object)) continue;
    const info =
      object.target.kind === 'provider' && object.target.provider === 'inlineComponent' ? infos.get(object.target.id) : undefined;
    const reserved = object.target.kind === 'reserved';
    rows.push(
      row(
        {
          tag: object.tag,
          className: object.className,
          hierarchy: pathOf(data, object.hierarchyId),
          status: reserved ? 'reserved' : elementOf(doc, object.target) === null ? 'orphan' : 'modelled',
          unverified: (info?.unverified ?? false) || Object.values(object.provenance ?? {}).some((entry) => entry.unverified === true),
          id: object.id,
          element: reserved ? null : (info?.component.id ?? object.target.id),
        },
        info,
      ),
    );
  }
  if (wholePlant) {
    const claimed = objectRegistry(data).byTarget;
    for (const info of infos.values())
      if (isValveType(info.component.type) && !claimed.has(`inlineComponent:${info.component.id}`))
        rows.push(row({ tag: info.component.tag ?? null }, info));
  }
  rows.sort(
    (a, b) =>
      naturalCompare(String(a['tag'] ?? '~'), String(b['tag'] ?? '~')) || naturalCompare(String(a['element']), String(b['element'])),
  );
  const count = (status: string): number => rows.filter((entry) => entry['status'] === status).length;
  return {
    columns: COLUMNS,
    rows,
    keyColumn: 'tag',
    method: 'none',
    totals: { valves: rows.length, modelled: count('modelled'), reserved: count('reserved'), unclassified: count('unclassified') },
    defaults: {},
  };
}
