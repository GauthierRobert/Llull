/**
 * Structural grid axes (column lines) with labelled bubbles.
 * @layer domain-aec
 */

import type { Vec2 } from '@core/model/types';
import type { BuildingModel, GridElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z, vec2 } from '@core/commands/schema';
import { fromMm, getBuilding, nextElementId, withElement, elementAffected } from './model';
import { distance } from '@lib/polygon';
import { noop } from '@core/commands/noop';
import { regenerateBuilding } from './evaluateElements';

export function gridLabels(building: BuildingModel): Set<string> {
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

export function nextFreeLabel(used: ReadonlySet<string>, numeric: boolean): string {
  for (let index = 0; ; index++) {
    const label = numeric ? String(index + 1) : gridLetter(index);
    if (!used.has(label)) return label;
  }
}

export function addGrid(
  building: BuildingModel,
  label: string,
  start: Vec2,
  end: Vec2,
): BuildingModel {
  const element: GridElement = {
    id: nextElementId(building, 'grid'),
    category: 'grid',
    mark: label,
    entityIds: [],
    start,
    end,
  };
  return withElement(building, element);
}

/**
 * @command add_grid_line
 * @pure
 * @affects creates the axis line + 2 bubbles + 2 labels
 * @failure zero length / duplicate label -> no-op
 */
export const addGridLine = defineCommand({
  name: 'add_grid_line',
  description:
    'Add one structural grid axis from start to end (plan [x, y]) with a labelled bubble at each end, ' +
    'on layer S-GRID. Label defaults to the next free number.',
  params: z.object({
    start: vec2('Axis start [x, y].'),
    end: vec2('Axis end [x, y].'),
    label: z.string().optional().describe('Bubble label, e.g. "A" or "3". Must be unique.'),
  }),
  run: (doc, { start, end, label }): CommandResult => {
    if (distance(start, end) <= 0) {
      return noop(doc, 'add_grid_line failed: start and end must be distinct [x, y] points.');
    }
    const building = getBuilding(doc);
    const used = gridLabels(building);
    const resolvedLabel = label?.trim() || nextFreeLabel(used, true);
    if (used.has(resolvedLabel)) {
      return noop(doc, `add_grid_line failed: grid label "${resolvedLabel}" already exists.`);
    }
    const next = addGrid(building, resolvedLabel, start, end);
    const id = next.elementOrder[next.elementOrder.length - 1] as string;
    const document = regenerateBuilding(doc, next);
    return {
      document,
      summary: `Added grid axis ${resolvedLabel} (${id}).`,
      affected: elementAffected(document, [id]),
      data: { elementId: id },
    };
  },
});

/**
 * @command add_grid_system
 * @pure
 * @affects creates (xSpacings.length + 1) numbered axes and (ySpacings.length + 1) lettered axes
 * @failure empty spacing lists or spacing <= 0 -> no-op
 */
export const addGridSystem = defineCommand({
  name: 'add_grid_system',
  description:
    'Lay out a rectangular structural grid. Numbered axes 1, 2, 3… run parallel to Y and are spaced ' +
    'along X by xSpacings; lettered axes A, B, C… (I and O skipped) run parallel to X, spaced along Y ' +
    'by ySpacings. E.g. xSpacings [6000, 6000] gives axes 1–3 six metres apart.',
  params: z.object({
    xSpacings: z
      .array(z.number())
      .describe('Bay widths along X between consecutive numbered axes (each > 0).'),
    ySpacings: z
      .array(z.number())
      .describe('Bay widths along Y between consecutive lettered axes (each > 0).'),
    origin: vec2('Intersection of axis 1 and axis A [x, y]. Default [0, 0].').optional(),
    extension: z
      .number()
      .optional()
      .describe('How far axes overrun the outer grid lines (document units). Default 1500 mm.'),
  }),
  run: (doc, { xSpacings, ySpacings, origin: originInput, extension }): CommandResult => {
    const validSpacings = (values: readonly number[]): boolean =>
      values.every((value) => value > 0);
    if (
      !validSpacings(xSpacings) ||
      !validSpacings(ySpacings) ||
      xSpacings.length + ySpacings.length === 0
    ) {
      return noop(
        doc,
        'add_grid_system failed: xSpacings / ySpacings must be lists of numbers > 0.',
      );
    }
    const overrun = extension ?? fromMm(doc, 1500);
    if (overrun < 0) {
      return noop(doc, 'add_grid_system failed: extension must be >= 0.');
    }
    const origin: Vec2 = originInput ?? [0, 0];
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
      affected: elementAffected(document, createdIds),
      data: { elementIds: createdIds, labels: created },
    };
  },
});
