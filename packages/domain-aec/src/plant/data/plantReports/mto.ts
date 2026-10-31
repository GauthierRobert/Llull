/**
 * Material take-off (plant 08 DAT §5.9, TR-DAT-12), grouped by `groupBy` (default spec, itemType, nominalSize). A legacy pipe is measured on its centreline (pipe
 * in m, bends in ea); a routed run of 02 RTE (M5) by the pieces its spec derives from the 01 PSC catalogue: pipe by cut length (take-outs deducted) in m, every
 * fitting, flange, gasket, bolt set and valve in ea under its takeoff key (`elbow90LR`, `valveGate` ...). Each row's `source` names the basis and the lines it
 * sums (AF-35); the table `method` is `centreline`, `cutLength` or `mixed`.
 */

import type { CadDocument } from '@core/model/types';
import { isProcessLine } from '../lines';
import { getPlantData, type PlantObject, type PlantValue } from '../model';
import { naturalCompare } from '../naturalSort';
import { mtoItems, type MtoBasis } from './mtoItems';
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
const BASIS_TEXT: Readonly<Record<MtoBasis, string>> = {
  centreline: 'centreline',
  cutLength: 'cut length, take-outs deducted',
  catalogue: 'catalogue parts',
};
const SOURCE_LINES = 8;

const compareCells = (a: PlantValue, b: PlantValue): number => {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return naturalCompare(String(a), String(b));
};

const compareItemTypes = (a: string, b: string): number => (ITEM_RANK[a] ?? 9) - (ITEM_RANK[b] ?? 9) || naturalCompare(a, b);

interface Group {
  readonly cells: Record<string, PlantValue>;
  readonly unit: string;
  quantity: number;
  readonly lines: Set<string>;
  readonly bases: Set<MtoBasis>;
  flagged: boolean;
}

function methodOf(bases: ReadonlySet<MtoBasis>): ReportTable['method'] {
  const centreline = bases.has('centreline');
  const routed = bases.has('cutLength') || bases.has('catalogue');
  return centreline && routed ? 'mixed' : routed ? 'cutLength' : 'centreline';
}

export function mto(doc: CadDocument, scoped: readonly PlantObject[], groupBy: readonly MtoDimension[]): ReportTable {
  const data = getPlantData(doc);
  const items = mtoItems(
    doc,
    scoped.filter((object) => isProcessLine(data, object)),
  );
  const groups = new Map<string, Group>();
  const bases = new Set<MtoBasis>();
  for (const item of items) {
    const cells = Object.fromEntries(groupBy.map((dimension) => [dimension, item[dimension]]));
    const key = JSON.stringify([...Object.values(cells), item.unit]);
    const group = groups.get(key) ?? {
      cells,
      unit: item.unit,
      quantity: 0,
      lines: new Set<string>(),
      bases: new Set<MtoBasis>(),
      flagged: false,
    };
    group.quantity += item.quantity;
    group.lines.add(item.line);
    group.bases.add(item.basis);
    group.flagged ||= item.flagged;
    bases.add(item.basis);
    groups.set(key, group);
  }
  const rows = [...groups.values()]
    .map((group): ReportRow => {
      const lines = [...group.lines].sort(naturalCompare);
      const shown = lines.slice(0, SOURCE_LINES).join(', ');
      const basis = [...group.bases].map((entry) => BASIS_TEXT[entry]).join(' + ');
      return {
        ...group.cells,
        quantity: round6(group.quantity),
        unit: group.unit,
        source:
          `${basis} of ${lines.length} line(s): ${shown}${lines.length > SOURCE_LINES ? `, +${lines.length - SOURCE_LINES} more` : ''}` +
          (group.flagged ? '; unverified (spec not approved, catalogue rows not grade A, or a run that no longer derives)' : ''),
      };
    })
    .sort((a, b) => {
      for (const dimension of groupBy) {
        const delta =
          dimension === 'itemType'
            ? compareItemTypes(String(a[dimension]), String(b[dimension]))
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
    method: methodOf(bases),
    totals: { pipeM: round6(metres), items: each },
    defaults: { groupBy: groupBy.join(', ') },
  };
}
