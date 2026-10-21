/** Planar polygons in 3D to counter-clockwise triangle facets, deterministically refined to a maximum edge length (PHY-03 view factors). */

import type { Vec3 } from '@core/model/vectors';
import { makeFacet, type Facet } from './viewFactorContour';
import { triangulatePolygon } from '@lib/triangulate';
import { add3, cross3, dot3, len3, scale3, sub3 } from '@lib/vec3';

export interface PlanarPolygon {
  readonly normal: Vec3;
  readonly area: number;
  /** largest distance of a vertex from the best-fit plane */
  readonly planarityError: number;
  readonly facets: readonly Facet[];
  /** true when refining would exceed the facet budget; `facets` is then empty */
  readonly overBudget: boolean;
}

/** Newell normal and area of a closed 3D loop. */
function newell(vertices: readonly Vec3[]): { readonly normal: Vec3; readonly area: number } {
  let sum: Vec3 = [0, 0, 0];
  for (let k = 0; k < vertices.length; k += 1) {
    sum = add3(sum, cross3(vertices[k] as Vec3, vertices[(k + 1) % vertices.length] as Vec3));
  }
  const twiceArea = len3(sum);
  return { normal: twiceArea > 0 ? scale3(sum, 1 / twiceArea) : [0, 0, 0], area: twiceArea / 2 };
}

const longestEdge = (corners: readonly [Vec3, Vec3, Vec3]): number =>
  Math.max(len3(sub3(corners[1], corners[0])), len3(sub3(corners[2], corners[1])), len3(sub3(corners[0], corners[2])));

const mid = (a: Vec3, b: Vec3): Vec3 => scale3(add3(a, b), 0.5);

/** Number of triangles midpoint refinement produces: 4^levels, levels = halvings of the longest edge needed. */
function refinedCount(corners: readonly [Vec3, Vec3, Vec3], maxSize: number | undefined): number {
  if (maxSize === undefined) return 1;
  let edge = longestEdge(corners);
  let count = 1;
  while (edge > maxSize) {
    edge /= 2;
    count *= 4;
  }
  return count;
}

function refine(corners: readonly [Vec3, Vec3, Vec3], maxSize: number | undefined, out: Facet[]): void {
  if (maxSize === undefined || longestEdge(corners) <= maxSize) {
    out.push(makeFacet(...corners));
    return;
  }
  const [a, b, c] = corners;
  const [ab, bc, ca] = [mid(a, b), mid(b, c), mid(c, a)];
  refine([a, ab, ca], maxSize, out);
  refine([ab, b, bc], maxSize, out);
  refine([ca, bc, c], maxSize, out);
  refine([ab, bc, ca], maxSize, out);
}

/**
 * Triangulate a planar polygon whose vertex order is counter-clockwise about the emitting normal (`flip` reverses it);
 * triangles keep that orientation; a triangle is split in four until its longest edge is <= `maxSize`.
 * More than `budget` facets: `overBudget` and no facets. Returns undefined for fewer than 3 vertices, a zero area or a failed triangulation.
 */
export function planarFacets(
  vertices: readonly Vec3[],
  flip: boolean,
  maxSize: number | undefined,
  budget = Infinity,
): PlanarPolygon | undefined {
  if (vertices.length < 3) return undefined;
  const loop = flip ? [...vertices].reverse() : [...vertices];
  const { normal, area } = newell(loop);
  if (!(area > 0)) return undefined;
  const origin = loop[0] as Vec3;
  const axisU = normalizeFrom(sub3(loop[1] as Vec3, origin), normal);
  const axisV = cross3(normal, axisU);
  const planarityError = Math.max(...loop.map((p) => Math.abs(dot3(sub3(p, origin), normal))));
  const key = (x: number, y: number): string => `${x},${y}`;
  const byProjection = new Map<string, Vec3>();
  const projected = loop.map((p): [number, number] => {
    const d = sub3(p, origin);
    const point: [number, number] = [dot3(d, axisU), dot3(d, axisV)];
    byProjection.set(key(point[0], point[1]), p);
    return point;
  });
  const mesh = triangulatePolygon(projected);
  if (!mesh.complete || mesh.triangles.length === 0) return undefined;
  const oriented: Array<readonly [Vec3, Vec3, Vec3]> = [];
  for (const [i, j, k] of mesh.triangles) {
    const corner = (index: number): Vec3 | undefined => {
      const point = mesh.vertices[index];
      return point === undefined ? undefined : byProjection.get(key(point[0], point[1]));
    };
    const [a, b, c] = [corner(i), corner(j), corner(k)];
    if (a === undefined || b === undefined || c === undefined) return undefined;
    oriented.push(dot3(cross3(sub3(b, a), sub3(c, a)), normal) >= 0 ? [a, b, c] : [a, c, b]);
  }
  const count = oriented.reduce((sum, corners) => sum + refinedCount(corners, maxSize), 0);
  if (count > budget) return { normal, area, planarityError, facets: [], overBudget: true };
  const facets: Facet[] = [];
  for (const corners of oriented) refine(corners, maxSize, facets);
  return { normal, area, planarityError, facets, overBudget: false };
}

/** Unit vector along `edge` projected into the plane with normal `normal`. */
function normalizeFrom(edge: Vec3, normal: Vec3): Vec3 {
  const inPlane = sub3(edge, scale3(normal, dot3(edge, normal)));
  const length = len3(inPlane);
  return length > 0 ? scale3(inPlane, 1 / length) : [1, 0, 0];
}
