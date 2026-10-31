/**
 * Material take-off (plant 08 DAT §5.9, TR-DAT-12): pipe quantity in metres (centreline) and bends in each, grouped by `groupBy`
 * (default spec, itemType, nominalSize). Take-outs and cut lengths belong to the spec-driven components (01 PSC / 02 RTE) and are not applied: the
 * method of every row is `centreline` and its `source` names the lines it sums.
 */

import type { CadDocument } from '@core/model/types';
import { pathOf } from '../hierarchy';
import { isProcessLine } from '../lines';
import { getPlantData, type PlantObject, type PlantValue } from '../model';
import { naturalCompare } from '../naturalSort';
import { lineGeometries } from './lineGeometry';
import { columnOf, round6, type ReportColumn, type ReportRow, type ReportTable } from './types';

export const MTO_DIMENSIONS = ['spec', 'itemType', 'nominalSize', 'line', 'hierarchy'] as const;
export type MtoDimension = (typeof MTO_DIMENSIONS)[number];
export const DEFAULT_MTO_GROUPING: readonly MtoDimension[] = ['spec', 'itemType', 'nominalSize'];

const DIMENSION_COLUMNS: Readonly<Record<MtoDimension, ReportColumn>> = {
  spec: columnOf('spec', 'Spec', 'text', null, 'property'),
  itemType: columnOf('itemType', 'Item type', 'text', null, 'derived'),
  nominalSize: columnOf('nominalSize', 'DN', 'integer', null, 'property'),
  line: columnOf('line', 'Line', 'text', null, 'derived'),
  hierarchy: columnOf('hierarchy', 'Hierarchy', 'text', null, 'derived'),
};

const ITEM_RANK: Readonly<Record<string, number>> = { pipe: 0, bend: 1 };
const UNIT_RANK: Readonly<Record<string, number>> = { m: 0, ea: 1 };
const SOURCE_LINES = 8;

interface Item {
  readonly spec: PlantValue;
  readonly itemType: 'pipe' | 'bend';
  readonly nominalSize: PlantValue;
  readonly line: string;
  readonly hierarchy: string;
  readonly quantity: number;
  readonly unit: 'm' | 'ea';
}

function itemsOf(doc: CadDocument, lines: readonly PlantObject[]): Item[] {
  const data = getPlantData(doc);
  const geometry = lineGeometries(doc);
  return lines.flatMap((line) => {
    const shape = geometry.get(line.id);
    if (shape === undefined || shape.lengthM === null) return [];
    const common = {
      spec: line.properties['spec'] ?? null,
      nominalSize: line.properties['nominalSize'] ?? shape.dn,
      line: line.tag,
      hierarchy: pathOf(data, line.hierarchyId),
    };
    const items: Item[] = [{ ...common, itemType: 'pipe', quantity: shape.lengthM, unit: 'm' }];
    if ((shape.bends ?? 0) > 0) items.push({ ...common, itemType: 'bend', quantity: shape.bends as number, unit: 'ea' });
    return items;
  });
}

const compareCells = (a: PlantValue, b: PlantValue): number => {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return naturalCompare(String(a), String(b));
};

export function mto(doc: CadDocument, scoped: readonly PlantObject[], groupBy: readonly MtoDimension[]): ReportTable {
  const data = getPlantData(doc);
  const items = itemsOf(
    doc,
    scoped.filter((object) => isProcessLine(data, object)),
  );
  const groups = new Map<string, { cells: Record<string, PlantValue>; unit: string; quantity: number; lines: Set<string> }>();
  for (const item of items) {
    const cells = Object.fromEntries(groupBy.map((dimension) => [dimension, item[dimension]]));
    const key = JSON.stringify([...Object.values(cells), item.unit]);
    const group = groups.get(key) ?? { cells, unit: item.unit, quantity: 0, lines: new Set<string>() };
    group.quantity += item.quantity;
    group.lines.add(item.line);
    groups.set(key, group);
  }
  const rows = [...groups.values()]
    .map((group): ReportRow => {
      const lines = [...group.lines].sort(naturalCompare);
      const shown = lines.slice(0, SOURCE_LINES).join(', ');
      return {
        ...group.cells,
        quantity: round6(group.quantity),
        unit: group.unit,
        source: `centreline of ${lines.length} line(s): ${shown}${lines.length > SOURCE_LINES ? `, +${lines.length - SOURCE_LINES} more` : ''}`,
      };
    })
    .sort((a, b) => {
      for (const dimension of groupBy) {
        const delta =
          dimension === 'itemType'
            ? (ITEM_RANK[String(a[dimension])] ?? 9) - (ITEM_RANK[String(b[dimension])] ?? 9)
            : compareCells(a[dimension] ?? null, b[dimension] ?? null);
        if (delta !== 0) return delta;
      }
      return (UNIT_RANK[String(a['unit'])] ?? 9) - (UNIT_RANK[String(b['unit'])] ?? 9);
    });
  const metres = rows.reduce((sum, row) => sum + (row['unit'] === 'm' ? Number(row['quantity']) : 0), 0);
  const each = rows.reduce((sum, row) => sum + (row['unit'] === 'ea' ? Number(row['quantity']) : 0), 0);
  return {
    columns: [
      ...groupBy.map((dimension) => DIMENSION_COLUMNS[dimension]),
      columnOf('quantity', 'Quantity', 'real', null, 'derived'),
      columnOf('unit', 'Unit', 'text', null, 'derived'),
      columnOf('source', 'Source', 'text', null, 'derived'),
    ],
    rows,
    keyColumn: null,
    method: 'centreline',
    totals: { pipeM: round6(metres), items: each },
    defaults: { groupBy: groupBy.join(', ') },
  };
}
