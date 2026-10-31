/**
 * Back clearance of a ladder (06 STA §5.1): from the rung centreline, rays along the facing direction at the middle and both stiles, against the
 * plan footprints of walls, columns, steel members, equipment, slabs and gratings whose height range contains a rung. The arrival surface is
 * not an obstacle (the climber steps onto it). Lengths in document units.
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import { fromMm } from '@core/model/units';
import { circlePolygon } from '@lib/arc';
import { pointInPolygon, segmentIntersection } from '@lib/polygon';
import type { BuildingElement, BuildingModel, LadderElement } from '@aec/building/types';
import { findProfile } from '../../../steel/profiles';
import { findGratingType } from '../grating/gratingTypes';
import { walkingSurfaces } from './ladderSurface';

/** How far behind the rungs the search looks, mm: a ladder with nothing nearer reports this value. */
export const BACK_SEARCH_MM = 2000;

interface Obstacle {
  readonly ring: ReadonlyArray<Vec2>;
  readonly zMin: number;
  readonly zMax: number;
}

/** Rectangle along the segment a->b, `width` across it, centred on it (a square of `width` when a = b). */
function stripRing(a: Vec2, b: Vec2, width: number): Vec2[] {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const half = width / 2;
  if (length === 0)
    return [
      [a[0] - half, a[1] - half],
      [a[0] + half, a[1] - half],
      [a[0] + half, a[1] + half],
      [a[0] - half, a[1] + half],
    ];
  const across: Vec2 = [(-(b[1] - a[1]) / length) * half, ((b[0] - a[0]) / length) * half];
  return [
    [a[0] - across[0], a[1] - across[1]],
    [b[0] - across[0], b[1] - across[1]],
    [b[0] + across[0], b[1] + across[1]],
    [a[0] + across[0], a[1] + across[1]],
  ];
}

function rotated(centre: Vec2, angle: number, length: number, width: number): Vec2[] {
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const corners: ReadonlyArray<Vec2> = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  return corners.map(
    ([u, v]): Vec2 => [centre[0] + (u * length * c - v * width * s) / 2, centre[1] + (u * length * s + v * width * c) / 2],
  );
}

function obstacleOf(doc: CadDocument, building: BuildingModel, element: BuildingElement): Obstacle | null {
  if (!('levelId' in element)) return null;
  const level = building.levels[element.levelId];
  if (level === undefined) return null;
  const z = level.elevation;
  switch (element.category) {
    case 'wall':
      return {
        ring: stripRing(element.start, element.end, element.thickness),
        zMin: z + element.baseOffset,
        zMax: z + element.baseOffset + element.height,
      };
    case 'column':
      return {
        ring:
          element.shape === 'circular'
            ? circlePolygon(element.location, element.width / 2, 16)
            : rotated(element.location, 0, element.width, element.depth),
        zMin: z,
        zMax: z + element.height,
      };
    case 'member': {
      const profile = findProfile(element.profile);
      if (profile === undefined) return null;
      const width = fromMm(doc, Math.max(profile.h, profile.b));
      return {
        ring: stripRing([element.start[0], element.start[1]], [element.end[0], element.end[1]], width),
        zMin: z + Math.min(element.start[2], element.end[2]) - width / 2,
        zMax: z + Math.max(element.start[2], element.end[2]) + width / 2,
      };
    }
    case 'equipment': {
      const [length, width, height] = element.size;
      const ring =
        element.shape === 'vertical_vessel'
          ? circlePolygon(element.location, Math.min(length, width) / 2, 24)
          : rotated(element.location, element.angle, length, width);
      return { ring, zMin: z, zMax: z + height };
    }
    default:
      return null;
  }
}

/** Distance along the ray from `origin` in `direction` (unit) to the ring: 0 when the origin is inside, Infinity when it misses within `reach`. */
function rayDistance(origin: Vec2, direction: Vec2, ring: ReadonlyArray<Vec2>, reach: number): number {
  if (pointInPolygon(origin, ring)) return 0;
  const end: Vec2 = [origin[0] + direction[0] * reach, origin[1] + direction[1] * reach];
  return Math.min(
    Infinity,
    ...ring.map((start, index) => {
      const hit = segmentIntersection(origin, end, start, ring[(index + 1) % ring.length] as Vec2);
      return hit === null ? Infinity : Math.hypot(hit[0] - origin[0], hit[1] - origin[1]);
    }),
  );
}

/**
 * Smallest distance from a rung centreline to an object behind it, document units; the search distance when nothing is nearer.
 * `base` is absolute in x, y; `rungHeights` are absolute z of the rungs; `exclude` is the arrival surface id.
 */
export function backClearance(
  doc: CadDocument,
  building: BuildingModel,
  ladder: Pick<LadderElement, 'facing' | 'clearWidth'> & { base: Vec2 },
  rungHeights: ReadonlyArray<number>,
  exclude: string | undefined,
): number {
  const search = fromMm(doc, BACK_SEARCH_MM);
  const direction: Vec2 = [Math.cos(ladder.facing), Math.sin(ladder.facing)];
  const left: Vec2 = [-direction[1], direction[0]];
  const origins = [-1, 0, 1].map(
    (side): Vec2 => [ladder.base[0] + (left[0] * side * ladder.clearWidth) / 2, ladder.base[1] + (left[1] * side * ladder.clearWidth) / 2],
  );
  const surfaces = new Map(walkingSurfaces(building).map((surface) => [surface.id, surface]));
  const obstacles: Obstacle[] = [];
  for (const element of Object.values(building.elements)) {
    if (element.id === exclude) continue;
    const surface = surfaces.get(element.id);
    if (surface !== undefined) {
      const depth =
        element.category === 'slab'
          ? element.thickness
          : element.category === 'grating'
            ? fromMm(doc, findGratingType(element.gratingType)?.barDepthMm ?? 0)
            : 0;
      obstacles.push({ ring: surface.ring, zMin: surface.top - depth, zMax: surface.top });
      continue;
    }
    const obstacle = obstacleOf(doc, building, element);
    if (obstacle !== null) obstacles.push(obstacle);
  }
  let nearest = search;
  for (const obstacle of obstacles) {
    if (!rungHeights.some((height) => height >= obstacle.zMin && height <= obstacle.zMax)) continue;
    for (const origin of origins) nearest = Math.min(nearest, rayDistance(origin, direction, obstacle.ring, search));
  }
  return nearest;
}
