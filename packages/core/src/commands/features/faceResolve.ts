/**
 * Resolve a face picked by a world point (`face: { near }`, KI5-style naming: re-resolved on every replay) to a planar frame.
 * Exact kernels (OCC) answer from the B-rep; a mesh kernel (Manifold) from the coplanar triangle cluster around the point.
 * @invariant the frame normal is the OUTWARD face normal; origin = the world origin projected on the plane
 * @failure nothing within tolerance -> 'not_found'; a curved surface -> 'not_planar'
 */

import type { GeometryKernel } from '../../geometry/kernel';
import type { FeatureFrame } from '../../model/features';
import type { ShapeRecipe, Vec3 } from '../../model/types';
import { meshDiagonal } from '../../geometry/meshExtent';
import { planeFrame } from '../../geometry/featureFrame';
import { type Triangle, closestPointOnTriangle } from '../../geometry/triangleQueries';
import { cross3, distance3, dot3, normalize3, sub3 } from '../../lib/vec3';

export interface ResolvedFace {
  readonly frame: FeatureFrame;
  /** Whether a point of the face plane lies on the (trimmed) face. */
  readonly contains: (point: Vec3) => boolean;
}

export type FaceResolution = ResolvedFace | 'not_found' | 'not_planar';

/** Largest dihedral (radians) between a planar cluster and a neighbour that still reads as a faceted curved surface. */
const FACETED_ANGLE = (25 * Math.PI) / 180;
const PLANE_COSINE = 1 - 1e-9;

/** Distance within which `near` identifies a face, in document units. */
const nearTolerance = (diagonal: number): number => 1e-3 * diagonal + 1e-6;

function exactFace(kernel: GeometryKernel, recipe: ShapeRecipe, near: Vec3): FaceResolution | null {
  const port = kernel.faceQuery;
  const shape = kernel.evaluate(recipe);
  const topology = shape === null ? null : kernel.topology(shape);
  if (port === undefined || shape === null || topology === null) return null;
  const nearest = port.distance(shape, [near])?.[0];
  const details = port.faceDetails(shape, { samples: 0 });
  if (nearest === undefined || details === null) return null;
  const mesh = kernel.tessellate(shape);
  const diagonal = mesh === null ? 1 : meshDiagonal(mesh);
  if (nearest.distance > nearTolerance(diagonal)) return 'not_found';
  const face = details[nearest.face];
  if (face?.surface !== 'plane' || face.normal === undefined) return 'not_planar';
  const frame = planeFrame(face.normal, face.centroid);
  const index = nearest.face;
  return { frame, contains: (point) => port.faceContains(shape, index, point, 1e-6 * (1 + diagonal)) === true };
}

function normalOf([a, b, c]: Triangle): Vec3 {
  return normalize3(cross3(sub3(b, a), sub3(c, a)));
}

/** The triangles of `mesh` (outward wound) as corner triples with their vertex indices. */
function trianglesOf(
  positions: readonly number[],
  indices: readonly number[],
): Array<{ corners: Triangle; ids: readonly [number, number, number] }> {
  const vertex = (i: number): Vec3 => [positions[i * 3] ?? 0, positions[i * 3 + 1] ?? 0, positions[i * 3 + 2] ?? 0];
  const triangles: Array<{ corners: Triangle; ids: readonly [number, number, number] }> = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const ids = [indices[t] ?? 0, indices[t + 1] ?? 0, indices[t + 2] ?? 0] as const;
    triangles.push({ corners: [vertex(ids[0]), vertex(ids[1]), vertex(ids[2])], ids });
  }
  return triangles;
}

const insideTriangle = (point: Vec3, triangle: Triangle, tolerance: number): boolean =>
  distance3(closestPointOnTriangle(point, triangle), point) <= tolerance;

function meshFace(kernel: GeometryKernel, recipe: ShapeRecipe, near: Vec3): FaceResolution {
  const shape = kernel.evaluate(recipe);
  const mesh = shape === null ? null : kernel.tessellate(shape);
  if (mesh === null) return 'not_found';
  const triangles = trianglesOf(mesh.positions, mesh.indices).filter(({ corners }) => distance3(corners[0], corners[1]) > 0);
  const diagonal = meshDiagonal(mesh);
  let seed = -1;
  let best = Infinity;
  triangles.forEach(({ corners }, index) => {
    const distance = distance3(closestPointOnTriangle(near, corners), near);
    if (distance < best - 1e-12) [seed, best] = [index, distance];
  });
  const first = triangles[seed];
  if (first === undefined || best > nearTolerance(diagonal)) return 'not_found';
  const normal = normalOf(first.corners);
  const offset = dot3(normal, first.corners[0]);
  const planeTolerance = 1e-7 * (1 + diagonal);
  const coplanar = triangles.map(
    ({ corners }) => dot3(normalOf(corners), normal) > PLANE_COSINE && Math.abs(dot3(normal, corners[0]) - offset) < planeTolerance,
  );
  const byEdge = new Map<string, number[]>();
  triangles.forEach(({ ids }, index) =>
    [0, 1, 2].forEach((k) => {
      const [first, second] = [ids[k] ?? 0, ids[(k + 1) % 3] ?? 0];
      const key = first < second ? `${first}:${second}` : `${second}:${first}`;
      byEdge.set(key, [...(byEdge.get(key) ?? []), index]);
    }),
  );
  const neighbours: number[][] = triangles.map(() => []);
  for (const sharing of byEdge.values()) for (const a of sharing) neighbours[a]?.push(...sharing.filter((b) => b !== a));
  const cluster = new Set<number>([seed]);
  const queue = [seed];
  let faceted = false;
  for (let current = queue.pop(); current !== undefined; current = queue.pop()) {
    for (const other of neighbours[current] ?? []) {
      if (coplanar[other] === true) {
        if (!cluster.has(other)) {
          cluster.add(other);
          queue.push(other);
        }
        continue;
      }
      const corners = triangles[other]?.corners;
      if (corners !== undefined && Math.acos(Math.min(1, dot3(normalOf(corners), normal))) < FACETED_ANGLE) faceted = true;
    }
  }
  if (faceted) return 'not_planar';
  const members = [...cluster].map((index) => (triangles[index] as { corners: Triangle }).corners);
  return {
    frame: planeFrame(normal, first.corners[0]),
    contains: (point) => members.some((corners) => insideTriangle(point, corners, 1e-6 * (1 + diagonal))),
  };
}

/** The planar face of `recipe` nearest to `near`, or why none qualifies. */
export function resolveFace(kernel: GeometryKernel, recipe: ShapeRecipe, near: Vec3): FaceResolution {
  return exactFace(kernel, recipe, near) ?? meshFace(kernel, recipe, near);
}
