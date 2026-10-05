/**
 * Footing / panel / column-foot helpers shared by the generators and the add_footing / add_panel commands.
 * @layer domain-aec
 * @pure
 */

import type { CadDocument, Vec2, Vec3 } from '@core/model/types';
import type { BuildingModel, FootingElement, PanelElement } from '@core/model/building';
import { distance } from '@lib/polygon';
import { fromMm, nextElementId, nextMark, toVec2, withElement } from '../model';
import { panelFrame } from './evaluate';

/** Upper bound on members one generator call may create (keeps agents from hanging the host). */
export const MAX_GENERATED_MEMBERS = 5000;

/**
 * Plan positions of every column foot on a level (steel columns and concrete columns),
 * de-duplicated; restricted to `onlyIds` when given.
 */
export function columnFeet(
  building: BuildingModel,
  levelId: string,
  tolerance: number,
  onlyIds?: ReadonlySet<string>,
): Vec2[] {
  const feet: Vec2[] = [];
  for (const element of Object.values(building.elements)) {
    if (!('levelId' in element) || element.levelId !== levelId) continue;
    if (onlyIds && !onlyIds.has(element.id)) continue;
    let foot: Vec2 | null = null;
    if (element.category === 'column') foot = element.location;
    if (element.category === 'member' && element.role === 'column') {
      foot =
        element.start[2] <= element.end[2]
          ? [element.start[0], element.start[1]]
          : [element.end[0], element.end[1]];
    }
    if (foot && !feet.some((existing) => distance(foot, existing) <= tolerance)) feet.push(foot);
  }
  return feet;
}

/** `locations` without the ones already carrying a footing on the level. */
export function withoutFootings(
  building: BuildingModel,
  levelId: string,
  locations: ReadonlyArray<Vec2>,
  tolerance: number,
): Vec2[] {
  const existing = Object.values(building.elements).flatMap((element) =>
    element.category === 'footing' && element.levelId === levelId ? [element.location] : [],
  );
  return locations.filter(
    (location) => !existing.some((footing) => distance(location, footing) <= tolerance),
  );
}

/** Adds pad footings (no regeneration). */
export function appendFootings(
  doc: CadDocument,
  building: BuildingModel,
  levelId: string,
  locations: ReadonlyArray<Vec2>,
  size: {
    width?: number | undefined;
    length?: number | undefined;
    thickness?: number | undefined;
    topOffset?: number | undefined;
    material?: string | undefined;
  },
): { building: BuildingModel; ids: string[] } {
  let next = building;
  const ids: string[] = [];
  const width = size.width ?? fromMm(doc, 1500);
  for (const location of locations) {
    const footing: FootingElement = {
      id: nextElementId(next, 'footing'),
      category: 'footing',
      mark: nextMark(next, 'footing'),
      entityIds: [],
      levelId,
      location: toVec2(location),
      width,
      length: size.length ?? width,
      thickness: size.thickness ?? fromMm(doc, 600),
      topOffset: size.topOffset ?? -fromMm(doc, 300),
      material: size.material?.trim() || 'concrete',
    };
    next = withElement(next, footing);
    ids.push(footing.id);
  }
  return { building: next, ids };
}

/** Adds one cladding panel (no regeneration); null when the corners are not a usable plane. */
export function appendPanel(
  doc: CadDocument,
  building: BuildingModel,
  levelId: string,
  spec: {
    corners: Vec3[];
    role: 'roof' | 'wall';
    thickness?: number | undefined;
    material?: string | undefined;
  },
): { building: BuildingModel; id: string } | null {
  if (spec.corners.length < 3 || !panelFrame(spec.corners)) return null;
  const panel: PanelElement = {
    id: nextElementId(building, 'panel'),
    category: 'panel',
    mark: nextMark(building, 'panel'),
    entityIds: [],
    levelId,
    role: spec.role,
    corners: spec.corners,
    thickness: spec.thickness ?? fromMm(doc, 80),
    material: spec.material?.trim() || 'sandwich-panel',
  };
  return { building: withElement(building, panel), id: panel.id };
}
