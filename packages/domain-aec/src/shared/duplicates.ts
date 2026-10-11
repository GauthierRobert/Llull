/**
 * Exact-duplicate detection for add_* commands (a twin element double-counts takeoff and clashes).
 * @layer domain-aec
 * @pure
 */

import type { BuildingElement, BuildingModel } from '@core/model/building';

type Point = ReadonlyArray<number>;

export const samePoint = (a: Point, b: Point): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** Same two end points in either direction. */
export const sameSegment = (a0: Point, a1: Point, b0: Point, b1: Point): boolean =>
  (samePoint(a0, b0) && samePoint(a1, b1)) || (samePoint(a0, b1) && samePoint(a1, b0));

/** Same vertex sequence, forwards or reversed. */
export const samePath = (a: ReadonlyArray<Point>, b: ReadonlyArray<Point>): boolean =>
  a.length === b.length &&
  (a.every((point, index) => samePoint(point, b[index] as Point)) ||
    a.every((point, index) => samePoint(point, b[b.length - 1 - index] as Point)));

/** Same closed outline: same vertices from any start vertex, in either winding. */
export const sameRing = (a: ReadonlyArray<Point>, b: ReadonlyArray<Point>): boolean =>
  a.length === b.length &&
  [1, -1].some((direction) =>
    a.some((_, shift) =>
      a.every((point, index) =>
        samePoint(
          point,
          b[(((shift + direction * index) % b.length) + b.length) % b.length] as Point,
        ),
      ),
    ),
  );

/** First element of `category` on `levelId` for which `matches` holds. */
export function findTwin<Category extends BuildingElement['category']>(
  building: BuildingModel,
  category: Category,
  levelId: string,
  matches: (element: Extract<BuildingElement, { category: Category }>) => boolean,
): Extract<BuildingElement, { category: Category }> | undefined {
  return Object.values(building.elements).find(
    (element): element is Extract<BuildingElement, { category: Category }> =>
      element.category === category &&
      'levelId' in element &&
      element.levelId === levelId &&
      matches(element as Extract<BuildingElement, { category: Category }>),
  );
}

/** Uniform refusal text naming the existing element. */
export const duplicateSummary = (command: string, twin: BuildingElement, what: string): string =>
  `${command} failed: ${what} already exists as ${twin.id} (${twin.mark}) on ${'levelId' in twin ? twin.levelId : 'its level'}; nothing added — edit it instead of adding a twin.`;
