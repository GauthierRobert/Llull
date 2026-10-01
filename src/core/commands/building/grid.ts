/**
 * Structural grid axes (column lines) with labelled bubbles.
 * @layer core/commands/building
 */

import type { Vec2 } from '../../model/types';
import type { BuildingModel, GridElement } from '../../model/building';
import type { CommandDefinition, CommandResult } from '../types';
import {
  fromMm,
  getBuilding,
  isFiniteNumber,
  isVec2,
  lengthOf,
  nextElementId,
  noChange,
  toVec2,
  withElement,
} from './model';
import { regenerateBuilding } from './evaluate';

function gridLabels(building: BuildingModel): Set<string> {
  return new Set(
    Object.values(building.elements)
      .filter((element) => element.category === 'grid')
      .map((element) => element.mark),
  );
}

/** Spreadsheet-style letters, skipping I and O (construction convention): A…H, J…N, P…Z, AA… */
export function gridLetter(index: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let remaining = index;
  let label = '';
  do {
    label = (alphabet[remaining % alphabet.length] as string) + label;
    remaining = Math.floor(remaining / alphabet.length) - 1;
  } while (remaining >= 0);
  return label;
}

function nextFreeLabel(used: ReadonlySet<string>, numeric: boolean): string {
  for (let index = 0; ; index++) {
    const label = numeric ? String(index + 1) : gridLetter(index);
    if (!used.has(label)) return label;
  }
}

function addGrid(building: BuildingModel, label: string, start: Vec2, end: Vec2): BuildingModel {
  const element: GridElement = {
    id: nextElementId(building, 'grid'),
    category: 'grid',
    mark: label,
    entityIds: [],
    start: toVec2(start),
    end: toVec2(end),
  };
  return withElement(building, element);
}

interface AddGridLineParams {
  start: Vec2;
  end: Vec2;
  label?: string;
}

/**
 * @command add_grid_line
 * @pure
 * @affects creates the axis line + 2 bubbles + 2 labels
 * @failure zero length / duplicate label -> no-op
 */
export const addGridLine: CommandDefinition<AddGridLineParams> = {
  name: 'add_grid_line',
  description:
    'Add one structural grid axis from start to end (plan [x, y]) with a labelled bubble at each end, ' +
    'on layer S-GRID. Label defaults to the next free number.',
  paramsSchema: {
    type: 'object',
    properties: {
      start: { type: 'array', items: { type: 'number' }, description: 'Axis start [x, y].' },
      end: { type: 'array', items: { type: 'number' }, description: 'Axis end [x, y].' },
      label: { type: 'string', description: 'Bubble label, e.g. "A" or "3". Must be unique.' },
    },
    required: ['start', 'end'],
  },
  run: (doc, { start, end, label }): CommandResult => {
    if (!isVec2(start) || !isVec2(end) || lengthOf(start, end) <= 0) {
      return noChange(doc, 'add_grid_line failed: start and end must be distinct [x, y] points.');
    }
    const building = getBuilding(doc);
    const used = gridLabels(building);
    const resolvedLabel = label?.trim() || nextFreeLabel(used, true);
    if (used.has(resolvedLabel)) {
      return noChange(doc, `add_grid_line failed: grid label "${resolvedLabel}" already exists.`);
    }
    const next = addGrid(building, resolvedLabel, start, end);
    const id = next.elementOrder[next.elementOrder.length - 1] as string;
    const document = regenerateBuilding(doc, next);
    return {
      document,
      summary: `Added grid axis ${resolvedLabel} (${id}).`,
      affected: document.building?.elements[id]?.entityIds ?? [],
      data: { elementId: id },
    };
  },
};

interface AddGridSystemParams {
  xSpacings: number[];
  ySpacings: number[];
  origin?: Vec2;
  extension?: number;
}

/**
 * @command add_grid_system
 * @pure
 * @affects creates (xSpacings.length + 1) numbered axes and (ySpacings.length + 1) lettered axes
 * @failure empty spacing lists or spacing <= 0 -> no-op
 */
export const addGridSystem: CommandDefinition<AddGridSystemParams> = {
  name: 'add_grid_system',
  description:
    'Lay out a rectangular structural grid. Numbered axes 1, 2, 3… run parallel to Y and are spaced ' +
    'along X by xSpacings; lettered axes A, B, C… (I and O skipped) run parallel to X, spaced along Y ' +
    'by ySpacings. E.g. xSpacings [6000, 6000] gives axes 1–3 six metres apart.',
  paramsSchema: {
    type: 'object',
    properties: {
      xSpacings: {
        type: 'array',
        items: { type: 'number' },
        description: 'Bay widths along X between consecutive numbered axes (each > 0).',
      },
      ySpacings: {
        type: 'array',
        items: { type: 'number' },
        description: 'Bay widths along Y between consecutive lettered axes (each > 0).',
      },
      origin: {
        type: 'array',
        items: { type: 'number' },
        description: 'Intersection of axis 1 and axis A [x, y]. Default [0, 0].',
      },
      extension: {
        type: 'number',
        description: 'How far axes overrun the outer grid lines (document units). Default 1500 mm.',
      },
    },
    required: ['xSpacings', 'ySpacings'],
  },
  run: (doc, { xSpacings, ySpacings, origin = [0, 0], extension }): CommandResult => {
    const validSpacings = (values: unknown): values is number[] =>
      Array.isArray(values) && values.every((value) => isFiniteNumber(value) && value > 0);
    if (
      !validSpacings(xSpacings) ||
      !validSpacings(ySpacings) ||
      xSpacings.length + ySpacings.length === 0
    ) {
      return noChange(
        doc,
        'add_grid_system failed: xSpacings / ySpacings must be lists of numbers > 0.',
      );
    }
    if (!isVec2(origin)) return noChange(doc, 'add_grid_system failed: origin must be [x, y].');
    const overrun = extension ?? fromMm(doc, 1500);
    if (!isFiniteNumber(overrun) || overrun < 0) {
      return noChange(doc, 'add_grid_system failed: extension must be >= 0.');
    }
    const xs = [origin[0]];
    for (const spacing of xSpacings) xs.push((xs[xs.length - 1] as number) + spacing);
    const ys = [origin[1]];
    for (const spacing of ySpacings) ys.push((ys[ys.length - 1] as number) + spacing);
    const [minX, maxX] = [xs[0] as number, xs[xs.length - 1] as number];
    const [minY, maxY] = [ys[0] as number, ys[ys.length - 1] as number];
    let building = getBuilding(doc);
    const used = new Set(gridLabels(building));
    const created: string[] = [];
    for (const x of xs) {
      const label = nextFreeLabel(used, true);
      used.add(label);
      building = addGrid(building, label, [x, minY - overrun], [x, maxY + overrun]);
      created.push(label);
    }
    for (const y of ys) {
      const label = nextFreeLabel(used, false);
      used.add(label);
      building = addGrid(building, label, [minX - overrun, y], [maxX + overrun, y]);
      created.push(label);
    }
    const document = regenerateBuilding(doc, building);
    const createdIds = building.elementOrder.slice(-created.length);
    return {
      document,
      summary: `Added grid system: axes ${created.join(', ')} spanning ${maxX - minX} × ${maxY - minY} ${doc.units}.`,
      affected: createdIds.flatMap((id) => document.building?.elements[id]?.entityIds ?? []),
      data: { elementIds: createdIds, labels: created },
    };
  },
};
