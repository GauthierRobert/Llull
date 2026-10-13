import type { BuildingElement, SteelMemberElement } from '@core/model/building';
import type { CadDocument } from '@core/model/types';

function buildingOf(doc: CadDocument): NonNullable<CadDocument['building']> {
  if (!doc.building) throw new Error('no building');
  return doc.building;
}

/** The document with every building element passed through `change` (same ids, same order). */
export function mapElements(
  doc: CadDocument,
  change: (element: BuildingElement) => BuildingElement,
): CadDocument {
  const building = buildingOf(doc);
  const elements = Object.fromEntries(
    Object.entries(building.elements).map(([id, element]) => [id, change(element)]),
  );
  return { ...doc, building: { ...building, elements } };
}

/** The document without the building elements for which `drop` is true. */
export function withoutElements(
  doc: CadDocument,
  drop: (element: BuildingElement) => boolean,
): CadDocument {
  const building = buildingOf(doc);
  const elements = Object.fromEntries(
    Object.entries(building.elements).filter(([, element]) => !drop(element)),
  );
  return {
    ...doc,
    building: {
      ...building,
      elements,
      elementOrder: building.elementOrder.filter((id) => id in elements),
    },
  };
}

/** A deep, untyped copy of the building for corrupting fields the types forbid. */
export const rawBuilding = (
  doc: CadDocument,
): { elements: Record<string, Record<string, unknown>> } =>
  JSON.parse(JSON.stringify(doc.building));

/** The steel members of `doc` with the given role. */
export const membersOf = (
  doc: CadDocument,
  role: SteelMemberElement['role'],
): SteelMemberElement[] =>
  Object.values(doc.building?.elements ?? {}).filter(
    (element): element is SteelMemberElement =>
      element.category === 'member' && element.role === role,
  );
