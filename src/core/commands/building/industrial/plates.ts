/**
 * Steel connections: column base plates with anchor bolts.
 * @layer core/commands/building/industrial
 */

import type { BasePlateElement, BuildingModel, SteelMemberElement } from '../../../model/building';
import type { CadDocument } from '../../../model/types';
import type { CommandDefinition, CommandResult } from '../../types';
import {
  elementAffected,
  fromMm,
  getBuilding,
  isFiniteNumber,
  nextElementId,
  nextMark,
  noChange,
  withElement,
} from '../model';
import { regenerateBuilding } from '../evaluate';
import { findProfile } from '../steel/profiles';
import { boltSize } from './evaluate';

const STEEL_DENSITY_KG_PER_M3 = 7850;

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

interface PlateSize {
  readonly margin?: number;
  readonly thickness?: number;
  readonly boltCount?: number;
  readonly boltDiameter?: number;
}

/** Adds one base plate per column (sized from its profile + margin); no regeneration. */
export function appendBasePlates(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  columns: ReadonlyArray<SteelMemberElement>,
  size: PlateSize,
): { building: BuildingModel; ids: string[] } {
  let next = building;
  const ids: string[] = [];
  const margin = size.margin ?? fromMm(doc, 100);
  for (const column of columns) {
    const profile = findProfile(column.profile);
    if (!profile) continue;
    const plate: BasePlateElement = {
      id: nextElementId(next, 'plate'),
      category: 'plate',
      mark: nextMark(next, 'plate'),
      entityIds: [],
      levelId: column.levelId,
      memberId: column.id,
      length: fromMm(doc, profile.h) + 2 * margin,
      width: fromMm(doc, profile.b) + 2 * margin,
      thickness: size.thickness ?? fromMm(doc, profile.h >= 300 ? 25 : 20),
      boltCount: size.boltCount ?? 4,
      boltDiameter: size.boltDiameter ?? fromMm(doc, 24),
      material: 'S355',
    };
    next = withElement(next, plate);
    ids.push(plate.id);
  }
  return { building: next, ids };
}

/**
 * Keeps the base plates of `member` consistent after an edit: re-sized (same overhang) when its
 * profile changed from `previousProfile`, removed when it is no longer a column.
 */
export function refitPlates(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  member: SteelMemberElement,
  previousProfile: string,
): { building: BuildingModel; resized: string[]; removed: string[] } {
  const plates = Object.values(building.elements).filter(
    (element): element is BasePlateElement =>
      element.category === 'plate' && element.memberId === member.id,
  );
  if (member.role !== 'column') {
    const removed = new Set(plates.map((plate) => plate.id));
    const elements = { ...building.elements };
    for (const id of removed) delete elements[id];
    return {
      building: {
        ...building,
        elements,
        elementOrder: building.elementOrder.filter((id) => !removed.has(id)),
      },
      resized: [],
      removed: [...removed],
    };
  }
  const [before, after] = [findProfile(previousProfile), findProfile(member.profile)];
  if (!before || !after || before.name === after.name) {
    return { building, resized: [], removed: [] };
  }
  let next = building;
  for (const plate of plates) {
    next = withElement(next, {
      ...plate,
      length: plate.length + fromMm(doc, after.h - before.h),
      width: plate.width + fromMm(doc, after.b - before.b),
    });
  }
  return { building: next, resized: plates.map((plate) => plate.id), removed: [] };
}

/** Steel columns of `levelId` (or `memberIds`) that do not yet carry a base plate. */
export function columnsWithoutPlates(
  building: BuildingModel,
  levelId: string | null,
  memberIds: ReadonlySet<string> | null,
): SteelMemberElement[] {
  const plated = new Set(
    Object.values(building.elements).flatMap((element) =>
      element.category === 'plate' ? [element.memberId] : [],
    ),
  );
  return building.elementOrder.flatMap((id) => {
    const element = building.elements[id];
    if (element?.category !== 'member' || element.role !== 'column' || plated.has(id)) return [];
    if (memberIds ? !memberIds.has(id) : element.levelId !== levelId) return [];
    return [element];
  });
}

interface AddBasePlatesParams {
  memberIds?: string[];
  levelId?: string;
  margin?: number;
  thickness?: number;
  boltCount?: number;
  boltDiameter?: number;
}

/**
 * @command add_base_plates
 * @pure
 * @affects creates 1 base plate (+ anchor bolts) per steel column without one
 * @failure bad sizes / odd bolt count / no unplated columns -> no-op
 */
export const addBasePlates: CommandDefinition<AddBasePlatesParams> = {
  name: 'add_base_plates',
  description:
    'Add steel base plates with anchor bolts under steel columns (the given memberIds, or every steel ' +
    'column of the level that has none yet). Plate = column profile + margin on each side; follows its ' +
    'column when it moves and is deleted / copied with it. Plate mass and bolt counts feed the takeoff.',
  paramsSchema: {
    type: 'object',
    properties: {
      memberIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Steel column ids. Default: every unplated steel column of the level.',
      },
      levelId: { type: 'string', description: 'Level id. Default: the active level.' },
      margin: { type: 'number', description: 'Plate overhang beyond the profile. Default 100 mm.' },
      thickness: {
        type: 'number',
        description: 'Plate thickness. Default 25 mm (20 mm for profiles < 300 deep).',
      },
      boltCount: { type: 'number', description: 'Anchor bolts, even, 2–12. Default 4.' },
      boltDiameter: { type: 'number', description: 'Bolt diameter. Default 24 mm (M24).' },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const positive = (value: number | undefined): boolean =>
      value === undefined || (isFiniteNumber(value) && value > 0);
    if (!positive(params.margin) || !positive(params.thickness) || !positive(params.boltDiameter)) {
      return noChange(
        doc,
        'add_base_plates failed: margin, thickness and boltDiameter must be > 0.',
      );
    }
    const boltCount = params.boltCount ?? 4;
    if (
      !(Number.isInteger(boltCount) && boltCount % 2 === 0 && boltCount >= 2 && boltCount <= 12)
    ) {
      return noChange(doc, 'add_base_plates failed: boltCount must be an even number 2–12.');
    }
    const building = getBuilding(doc);
    const levelId = params.levelId ?? building.activeLevelId ?? building.levelOrder[0] ?? null;
    if (params.levelId !== undefined && !building.levels[params.levelId]) {
      return noChange(doc, `add_base_plates failed: no level '${params.levelId}'.`);
    }
    const columns = columnsWithoutPlates(
      building,
      levelId,
      Array.isArray(params.memberIds) ? new Set(params.memberIds) : null,
    );
    if (columns.length === 0) {
      return noChange(doc, 'add_base_plates failed: no steel column without a base plate found.');
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
};
