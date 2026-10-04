/**
 * Steel connections: column base plates with anchor bolts.
 * @layer domain-aec
 */

import type { BasePlateElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { elementAffected, fromMm, getBuilding } from '../model';
import { noop } from '@core/commands/noop';
import { isFiniteNumber } from '@lib/isFiniteNumber';
import { regenerateBuilding } from '../evaluateElements';
import { STEEL_DENSITY_KG_PER_M3 } from '../steel/profiles';
import { boltSize } from './evaluate';
import { appendBasePlates, columnsWithoutPlates } from './plateSupport';

/** Plate mass in kg (sizes in document units). */
export function plateMass(doc: Pick<CadDocument, 'units'>, plate: BasePlateElement): number {
  const metres = fromMm(doc, 1000);
  return (
    (plate.length / metres) *
    (plate.width / metres) *
    (plate.thickness / metres) *
    STEEL_DENSITY_KG_PER_M3
  );
}

/**
 * @command add_base_plates
 * @pure
 * @affects creates 1 base plate (+ anchor bolts) per steel column without one
 * @failure bad sizes / odd bolt count / no unplated columns -> no-op
 */
export const addBasePlates = defineCommand({
  name: 'add_base_plates',
  description:
    'Add steel base plates with anchor bolts under steel columns (the given memberIds, or every steel ' +
    'column of the level that has none yet). Plate = column profile + margin on each side; follows its ' +
    'column when it moves and is deleted / copied with it. Plate mass and bolt counts feed the takeoff.',
  params: z.object({
    memberIds: z
      .array(z.string())
      .optional()
      .describe('Steel column ids. Default: every unplated steel column of the level.'),
    levelId: z.string().optional().describe('Level id. Default: the active level.'),
    margin: z.number().optional().describe('Plate overhang beyond the profile. Default 100 mm.'),
    thickness: z
      .number()
      .optional()
      .describe('Plate thickness. Default 25 mm (20 mm for profiles < 300 deep).'),
    boltCount: z.number().optional().describe('Anchor bolts, even, 2–12. Default 4.'),
    boltDiameter: z.number().optional().describe('Bolt diameter. Default 24 mm (M24).'),
  }),
  run: (doc, params): CommandResult => {
    const positive = (value: number | undefined): boolean =>
      value === undefined || (isFiniteNumber(value) && value > 0);
    if (!positive(params.margin) || !positive(params.thickness) || !positive(params.boltDiameter)) {
      return noop(doc, 'add_base_plates failed: margin, thickness and boltDiameter must be > 0.');
    }
    const boltCount = params.boltCount ?? 4;
    if (
      !(Number.isInteger(boltCount) && boltCount % 2 === 0 && boltCount >= 2 && boltCount <= 12)
    ) {
      return noop(doc, 'add_base_plates failed: boltCount must be an even number 2–12.');
    }
    const building = getBuilding(doc);
    const levelId = params.levelId ?? building.activeLevelId ?? building.levelOrder[0] ?? null;
    if (params.levelId !== undefined && !building.levels[params.levelId]) {
      return noop(doc, `add_base_plates failed: no level '${params.levelId}'.`);
    }
    const columns = columnsWithoutPlates(
      building,
      levelId,
      Array.isArray(params.memberIds) ? new Set(params.memberIds) : null,
    );
    if (columns.length === 0) {
      return noop(doc, 'add_base_plates failed: no steel column without a base plate found.');
    }
    const added = appendBasePlates(doc, building, columns, {
      ...(params.margin !== undefined ? { margin: params.margin } : {}),
      ...(params.thickness !== undefined ? { thickness: params.thickness } : {}),
      boltCount,
      ...(params.boltDiameter !== undefined ? { boltDiameter: params.boltDiameter } : {}),
    });
    const document = regenerateBuilding(doc, added.building);
    const plates = added.ids.map((id) => added.building.elements[id] as BasePlateElement);
    const kilograms = plates.reduce((sum, plate) => sum + plateMass(doc, plate), 0);
    return {
      document,
      summary: `Added ${plates.length} base plate(s) with ${plates.length * boltCount} anchor bolt(s) ${boltSize(doc, plates[0]?.boltDiameter ?? 0)}: ${kilograms.toFixed(1)} kg of plate.`,
      affected: elementAffected(document, added.ids),
      data: { elementIds: added.ids },
    };
  },
});
