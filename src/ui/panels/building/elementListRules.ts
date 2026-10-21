import type { BuildingElement, BuildingModel } from '@aec/index';
import { orderedValues } from '@ui/panels/orderedValues';

/** Elements of the active level, plus level-less ones (grids) and hosted ones (by their host's level). */
export function elementsOnActiveLevel(building: BuildingModel | undefined): BuildingElement[] {
  if (!building) return [];
  return orderedValues(building.elementOrder, building.elements).filter((element) => {
    const host = 'hostId' in element ? building.elements[element.hostId] : undefined;
    const levelId = 'levelId' in element ? element.levelId : host && 'levelId' in host ? host.levelId : null;
    return levelId === null || levelId === building.activeLevelId;
  });
}

/** True when the element has geometry and every one of its entities is in `selected`. */
export function isElementSelected(element: BuildingElement, selected: ReadonlySet<string>): boolean {
  return element.entityIds.length > 0 && element.entityIds.every((id) => selected.has(id));
}
