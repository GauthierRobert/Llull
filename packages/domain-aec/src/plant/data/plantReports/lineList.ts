/** Line list (plant 08 DAT §5.9): one row per process line object with designation, ends, size, spec, centreline length, bends and design conditions. */

import type { CadDocument } from '@core/model/types';
import { pathOf } from '../hierarchy';
import { isProcessLine, lineEnds, resolveEnd } from '../lines';
import { getPlantData, type PlantObject } from '../model';
import { lineGeometries } from './lineGeometry';
import { propertyReader } from './propertyColumns';
import { isUnverified } from './scope';
import { columnOf, round6, type ReportColumn, type ReportRow, type ReportTable } from './types';

const CONDITIONS: ReadonlyArray<readonly [string, string]> = [
  ['DesignPressure', 'Design pressure'],
  ['DesignTemperature', 'Design temperature'],
  ['OperatingPressure', 'Operating pressure'],
  ['OperatingTemperature', 'Operating temperature'],
  ['TestPressure', 'Test pressure'],
  ['Insulation', 'Insulation'],
];

export function lineList(doc: CadDocument, scoped: readonly PlantObject[]): ReportTable {
  const data = getPlantData(doc);
  const lines = scoped.filter((object) => isProcessLine(data, object));
  const geometry = lineGeometries(doc);
  const readers = CONDITIONS.flatMap(([name, display]) => propertyReader(doc, lines, name, display) ?? []);
  const columns: ReportColumn[] = [
    columnOf('tag', 'Line number', 'text', null, 'derived'),
    columnOf('className', 'Class', 'text', null, 'derived'),
    columnOf('nominalSize', 'DN', 'integer', null, 'property'),
    columnOf('fluidCode', 'Fluid code', 'text', null, 'property'),
    columnOf('spec', 'Spec', 'text', null, 'property'),
    columnOf('from', 'From', 'text', null, 'property'),
    columnOf('to', 'To', 'text', null, 'property'),
    columnOf('fromStatus', 'From resolved', 'text', null, 'derived'),
    columnOf('toStatus', 'To resolved', 'text', null, 'derived'),
    columnOf('lengthM', 'Length', 'real', 'm', 'geometry'),
    columnOf('straights', 'Straights', 'integer', null, 'geometry'),
    columnOf('bends', 'Bends', 'integer', null, 'geometry'),
    ...readers.map((reader) => reader.column),
    columnOf('hierarchy', 'Hierarchy', 'text', null, 'derived'),
    columnOf('unverified', 'Unverified', 'boolean', null, 'derived'),
    columnOf('id', 'ObjectId', 'text', null, 'derived'),
  ];
  let length = 0;
  let bends = 0;
  const rows = lines.map((line): ReportRow => {
    const ends = lineEnds(doc, line);
    const shape = geometry.get(line.id);
    length += shape?.lengthM ?? 0;
    bends += shape?.bends ?? 0;
    return {
      tag: line.tag,
      className: line.className,
      nominalSize: line.properties['nominalSize'] ?? shape?.dn ?? null,
      fluidCode: line.properties['fluidCode'] ?? null,
      spec: line.properties['spec'] ?? null,
      from: ends.from ?? null,
      to: ends.to ?? null,
      fromStatus: resolveEnd(doc, data, line, ends.from),
      toStatus: resolveEnd(doc, data, line, ends.to),
      lengthM: shape?.lengthM ?? null,
      straights: shape?.straights ?? null,
      bends: shape?.bends ?? null,
      ...Object.fromEntries(readers.map((reader) => [reader.column.name, reader.read(line)])),
      hierarchy: pathOf(data, line.hierarchyId),
      unverified: isUnverified(line),
      id: line.id,
    };
  });
  return {
    columns,
    rows,
    keyColumn: 'tag',
    method: 'centreline',
    totals: { lines: rows.length, lengthM: round6(length), bends },
    defaults: { batteryLimitPattern: data.settings.batteryLimitPattern },
  };
}
