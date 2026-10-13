/**
 * Base plate creation, refitting after member edits, and lookup of unplated columns.
 * @layer domain-aec
 * @pure
 */

import type { BasePlateElement, BuildingModel, SteelMemberElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { fromMm } from '@core/model/units';
import { elementsOf, appendElements, withElement, withoutElements } from '../../building/model';
import { findProfile } from '../../steel/profiles';

interface PlateSize {
  readonly margin?: number | undefined;
  readonly thickness?: number | undefined;
  readonly boltCount?: number | undefined;
  readonly boltDiameter?: number | undefined;
  /** Stored on the plate only when 'fixed' (absent = pinned). */
  readonly fixity?: 'pinned' | 'fixed' | undefined;
}

/** Adds one base plate per column (sized from its profile + margin); no regeneration. */
export function appendBasePlates(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  columns: ReadonlyArray<SteelMemberElement>,
  size: PlateSize,
): { building: BuildingModel; ids: string[] } {
  const margin = size.margin ?? fromMm(doc, 100);
  return appendElements(building, columns, 'plate', (column, id, mark): BasePlateElement | undefined => {
    const profile = findProfile(column.profile);
    if (!profile) return undefined;
    return {
      id,
      category: 'plate',
      mark,
      entityIds: [],
      levelId: column.levelId,
      memberId: column.id,
      length: fromMm(doc, profile.h) + 2 * margin,
      width: fromMm(doc, profile.b) + 2 * margin,
      thickness: size.thickness ?? fromMm(doc, profile.h >= 300 ? 25 : 20),
      boltCount: size.boltCount ?? 4,
      boltDiameter: size.boltDiameter ?? fromMm(doc, 24),
      material: 'S355',
      ...(size.fixity === 'fixed' ? { fixity: 'fixed' as const } : {}),
    };
  });
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
  const plates = elementsOf(building, 'plate').filter((plate) => plate.memberId === member.id);
  if (member.role !== 'column') {
    const removed = new Set(plates.map((plate) => plate.id));
    return { building: withoutElements(building, removed), resized: [], removed: [...removed] };
  }
  const [before, after] = [findProfile(previousProfile), findProfile(member.profile)];
  if (!before || !after || before.name === after.name) return { building, resized: [], removed: [] };
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
  const plated = new Set(elementsOf(building, 'plate').map((plate) => plate.memberId));
  return elementsOf(building, 'member').filter(
    (element) =>
      element.role === 'column' && !plated.has(element.id) && (memberIds ? memberIds.has(element.id) : element.levelId === levelId),
  );
}
