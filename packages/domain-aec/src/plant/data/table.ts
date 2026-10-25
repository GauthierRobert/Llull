/**
 * The plant data table (plant 08 DAT §4 `plant_data_table`, §5.9): one row per plant object, base columns then the property columns of the classes,
 * typed column descriptors with units, natural tag order, paging. A pure function of the document.
 */

import type { CadDocument } from '@core/model/types';
import { concreteDescendants, isKindOf, resolvedOrNull } from './classes';
import { pathOf, resolveNode, subtreeIds } from './hierarchy';
import { getPlantData, type PlantObject, type PlantValue, type PropertyDefinition } from './model';
import { naturalCompare } from './naturalSort';
import { elementOf } from './providers';

export interface TableColumn {
  readonly name: string;
  readonly displayName: string;
  readonly type: string;
  readonly unit: string | null;
  readonly readOnly: boolean;
}

export type TableRow = Readonly<Record<string, PlantValue>>;

const BASE: readonly TableColumn[] = [
  { name: 'id', displayName: 'ObjectId', type: 'text', unit: null, readOnly: true },
  { name: 'tag', displayName: 'Tag', type: 'text', unit: null, readOnly: true },
  { name: 'className', displayName: 'Class', type: 'text', unit: null, readOnly: true },
  { name: 'hierarchy', displayName: 'Hierarchy', type: 'text', unit: null, readOnly: true },
  { name: 'target', displayName: 'Model object', type: 'text', unit: null, readOnly: true },
  { name: 'unverified', displayName: 'Unverified values', type: 'text', unit: null, readOnly: true },
];

const columnOf = (definition: PropertyDefinition): TableColumn => ({
  name: definition.name,
  displayName: definition.displayName,
  type: definition.type,
  unit: definition.unit ?? null,
  readOnly: definition.readOnly === true,
});

export interface TableQuery {
  readonly className?: string;
  readonly includeSubclasses: boolean;
  readonly hierarchy?: string;
  readonly columns?: readonly string[];
  readonly filter: Readonly<Record<string, PlantValue>>;
  readonly sort: readonly string[];
  readonly offset: number;
  readonly limit: number;
}

export type TableResult =
  | { readonly ok: true; readonly columns: readonly TableColumn[]; readonly rows: readonly TableRow[]; readonly total: number }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly path: string };

function rowOf(doc: CadDocument, object: PlantObject): Record<string, PlantValue> {
  const data = getPlantData(doc);
  const model = object.target.kind === 'reserved' ? null : elementOf(doc, object.target);
  const unverified = Object.entries(object.provenance ?? {}).flatMap(([name, provenance]) =>
    provenance.unverified === true ? [name] : [],
  );
  return {
    id: object.id,
    tag: object.tag,
    className: object.className,
    hierarchy: pathOf(data, object.hierarchyId),
    target: object.target.kind === 'reserved' ? 'reserved' : (model?.element.label ?? `orphan: ${object.target.id}`),
    unverified: unverified.join(', '),
    ...object.properties,
  };
}

const compareValues = (a: PlantValue | undefined, b: PlantValue | undefined): number => {
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return naturalCompare(String(a), String(b));
};

export function buildDataTable(doc: CadDocument, query: TableQuery): TableResult {
  const data = getPlantData(doc);
  if (query.className !== undefined && data.classes[query.className] === undefined)
    return {
      ok: false,
      code: 'DAT_CLASS_UNKNOWN',
      message: `no class "${query.className}" (${data.classOrder.join(', ')})`,
      path: 'className',
    };
  let scope: Set<string> | null = null;
  if (query.hierarchy !== undefined) {
    const node = resolveNode(data, query.hierarchy);
    if (node === null || node === 'ambiguous')
      return {
        ok: false,
        code: 'DAT_HIERARCHY_UNKNOWN',
        message: `no (or an ambiguous) hierarchy node "${query.hierarchy}"`,
        path: 'hierarchy',
      };
    scope = subtreeIds(data, node.id);
  }
  const selected = data.objectOrder.flatMap((id) => {
    const object = data.objects[id];
    if (object === undefined || (scope !== null && !scope.has(object.hierarchyId))) return [];
    const matches =
      query.className === undefined ||
      (query.includeSubclasses ? isKindOf(data, object.className, query.className) : object.className === query.className);
    return matches ? [object] : [];
  });
  const properties = new Map<string, TableColumn>();
  const sources =
    query.className === undefined
      ? data.classOrder
      : query.includeSubclasses
        ? [query.className, ...concreteDescendants(data, query.className).map((cls) => cls.name)]
        : [query.className];
  for (const name of sources)
    for (const definition of resolvedOrNull(data, name)?.properties ?? [])
      if (!properties.has(definition.name)) properties.set(definition.name, columnOf(definition));
  const known = new Map<string, TableColumn>([...BASE, ...properties.values()].map((column) => [column.name, column]));
  for (const [path, names] of [
    ['columns', query.columns ?? []],
    ['filter', Object.keys(query.filter)],
    ['sort', query.sort.map((entry) => entry.replace(/^-/, ''))],
  ] as const)
    for (const name of names)
      if (!known.has(name))
        return { ok: false, code: 'DAT_COLUMN_UNKNOWN', message: `no column "${name}" (${[...known.keys()].join(', ')})`, path };
  const columns = query.columns === undefined ? [...known.values()] : query.columns.map((name) => known.get(name) as TableColumn);
  let rows = selected.map((object) => rowOf(doc, object));
  for (const [name, wanted] of Object.entries(query.filter)) rows = rows.filter((row) => (row[name] ?? null) === wanted);
  const order = query.sort.length === 0 ? ['tag'] : query.sort;
  rows.sort((a, b) => {
    for (const entry of order) {
      const descending = entry.startsWith('-');
      const name = descending ? entry.slice(1) : entry;
      const delta = compareValues(a[name], b[name]);
      if (delta !== 0) return descending ? -delta : delta;
    }
    return 0;
  });
  const total = rows.length;
  const page = rows
    .slice(query.offset, query.offset + query.limit)
    .map((row) => Object.fromEntries(columns.map((column) => [column.name, row[column.name] ?? null])));
  return { ok: true, columns, rows: page, total };
}
