/** Walking surfaces a ladder can arrive on (06 STA §5.7): slabs and gratings with their top, and the plan distance to them. */

import type { Vec2 } from '@core/model/types';
import { pointInPolygon, projectOntoSegment } from '@lib/polygon';
import type { BuildingModel } from '@aec/building/types';
import { elementsOf } from '@aec/building/model';

export interface WalkingSurface {
  readonly id: string;
  readonly levelId: string;
  readonly ring: ReadonlyArray<Vec2>;
  /** Absolute top, document units. */
  readonly top: number;
}

/** Slabs and grating panels of the building with their absolute top (level elevation + offset). */
export function walkingSurfaces(building: BuildingModel): WalkingSurface[] {
  const surfaces: WalkingSurface[] = [];
  for (const slab of elementsOf(building, 'slab')) {
    const level = building.levels[slab.levelId];
    if (level !== undefined) surfaces.push({ id: slab.id, levelId: slab.levelId, ring: slab.boundary, top: level.elevation + slab.offset });
  }
  for (const grating of elementsOf(building, 'grating')) {
    const level = building.levels[grating.levelId];
    if (level !== undefined)
      surfaces.push({ id: grating.id, levelId: grating.levelId, ring: grating.boundary, top: level.elevation + grating.topOffset });
  }
  return surfaces;
}

/** Plan distance from `point` to the polygon: 0 inside, else to the nearest edge. */
export function distanceToRing(point: Vec2, ring: ReadonlyArray<Vec2>): number {
  if (pointInPolygon(point, ring)) return 0;
  return Math.min(...ring.map((start, index) => projectOntoSegment(point, start, ring[(index + 1) % ring.length] as Vec2).distance));
}

/** The surface whose top is within `tolerance` of `top` and whose plan lies within `reach` of `point`; the nearest, then the lowest id. */
export function arrivalSurface(
  surfaces: ReadonlyArray<WalkingSurface>,
  point: Vec2,
  top: number,
  tolerance: number,
  reach: number,
): WalkingSurface | undefined {
  return surfaces
    .filter((surface) => Math.abs(surface.top - top) <= tolerance)
    .map((surface) => ({ surface, distance: distanceToRing(point, surface.ring) }))
    .filter((candidate) => candidate.distance <= reach)
    .sort((a, b) => a.distance - b.distance || a.surface.id.localeCompare(b.surface.id))[0]?.surface;
}
