/**
 * Face resolution for PMI (03 GDT TECHNICAL_SPEC §5.1): turn `facesNear` points into B-rep faces of a solid through the face-query port,
 * the way `edgesNear` selects edges (KI5). Points, never indices, are the persisted recipe, so a replay on a regenerated B-rep finds the
 * same logical faces.
 * @invariant a point picks the nearest face by exact surface distance (planes, cylinders, spheres; sample points otherwise) accepted only
 *   when its projection lies inside the trimmed face; faces of the SAME surface within tolerance are merged (split faces of one surface)
 * @failure no topology / face port -> GDT_KERNEL_NO_TOPOLOGY; no face within tolerance -> GDT_POINT_NOT_ON_FACE; two different surfaces
 *   within tolerance -> GDT_FACE_AMBIGUOUS
 */

import type { ShapeRecipe, Vec3 } from '../model/types';
import type { PmiSurface } from '../model/pmi';
import type { GeometryKernel, ShapeTopology } from './kernel';
import type { FaceDetail, FaceQueryPort } from './kernelPorts';
import type { ShapeHandle } from './kernelTypes';
import { meshDiagonal } from './meshExtent';
import { add3, distance3, dot3, len3, scale3, sub3 } from '../lib/vec3';

/** Sample points requested per face for the nearest-sample fallback. */
const SAMPLES_PER_FACE = 64;

export interface FeatureProblem {
  readonly code: 'GDT_KERNEL_NO_TOPOLOGY' | 'GDT_POINT_NOT_ON_FACE' | 'GDT_FACE_AMBIGUOUS';
  readonly message: string;
  /** Indices into the `points` array that caused it. */
  readonly pointIndices: readonly number[];
}

export interface ResolvedFeature {
  /** Faces of the feature, ascending kernel index, deduplicated. */
  readonly faces: readonly FaceDetail[];
  readonly surface: PmiSurface;
  readonly topology: ShapeTopology;
  /** Distance below which a point identifies a face, document units. */
  readonly tolerance: number;
  /** Bounding-box diagonal of the solid, document units (scales annotation placement). */
  readonly diagonal: number;
  /** Per input point: the indices of the faces it selected. */
  readonly byPoint: readonly (readonly number[])[];
}

export const isFeatureProblem = (value: ResolvedFeature | FeatureProblem): value is FeatureProblem => 'code' in value;

/** Face identification tolerance for a solid of bounding diagonal `diagonal`. */
export const faceTolerance = (diagonal: number): number => Math.max(1e-3 * diagonal, 1e-6);

/** Everything a feature resolution needs from the kernel for one solid; null-safe pieces turned into a problem. */
export interface SolidFaces {
  readonly handle: ShapeHandle;
  readonly port: FaceQueryPort;
  readonly details: readonly FaceDetail[];
  readonly topology: ShapeTopology;
  readonly tolerance: number;
  readonly diagonal: number;
}

export function openSolid(kernel: GeometryKernel | null, recipe: ShapeRecipe): SolidFaces | FeatureProblem {
  const refuse = (message: string): FeatureProblem => ({ code: 'GDT_KERNEL_NO_TOPOLOGY', message, pointIndices: [] });
  const port = kernel?.faceQuery;
  if (kernel === null || port === undefined) return refuse('requires the OCC kernel (exact topology and face queries)');
  const handle = kernel.evaluate(recipe);
  const topology = handle === null ? null : kernel.topology(handle);
  if (handle === null || topology === null) return refuse('the kernel could not build the solid or has no exact topology for it');
  const details = port.faceDetails(handle, { samples: SAMPLES_PER_FACE });
  if (details === null) return refuse('the kernel could not compute the faces of the solid');
  const mesh = kernel.tessellate(handle);
  const diagonal = mesh === null ? 1 : meshDiagonal(mesh);
  return { handle, port, details, topology, tolerance: faceTolerance(diagonal), diagonal };
}

/** Closest point of the face's own surface to `p` and the distance to it (null when the face has no analytic surface here). */
function surfaceProjection(face: FaceDetail, p: Vec3): { point: Vec3; distance: number } | null {
  if (face.surface === 'plane' && face.normal !== undefined) {
    const offset = dot3(sub3(p, face.centroid), face.normal);
    return { point: sub3(p, scale3(face.normal, offset)), distance: Math.abs(offset) };
  }
  const axis = face.axis;
  if (face.surface === 'cylinder' && axis !== undefined && face.radius !== undefined) {
    const v = sub3(p, axis.origin);
    const along = dot3(v, axis.dir);
    const radial = sub3(v, scale3(axis.dir, along));
    const r = len3(radial);
    if (r < 1e-12) return null;
    return {
      point: add3(add3(axis.origin, scale3(axis.dir, along)), scale3(radial, face.radius / r)),
      distance: Math.abs(r - face.radius),
    };
  }
  if (face.surface === 'sphere' && axis !== undefined && face.radius !== undefined) {
    const v = sub3(p, axis.origin);
    const r = len3(v);
    return r < 1e-12 ? null : { point: add3(axis.origin, scale3(v, face.radius / r)), distance: Math.abs(r - face.radius) };
  }
  return null;
}

/** Distance from `p` to the face: exact surface distance when the projection is inside the trimmed face, else the nearest sample. */
function faceDistance(frame: SolidFaces, face: FaceDetail, p: Vec3): number {
  const projection = surfaceProjection(face, p);
  if (projection !== null) {
    const inside = frame.port.faceContains(frame.handle, face.index, projection.point, frame.tolerance);
    if (inside !== false) return projection.distance;
  }
  let best = Infinity;
  for (const sample of face.samples) best = Math.min(best, distance3(sample, p));
  return best;
}

/** Whether two faces lie on the same underlying surface (coincident split faces of one plane, cylinder or sphere). */
function sameSurface(a: FaceDetail, b: FaceDetail, tolerance: number): boolean {
  if (a.index === b.index) return true;
  if (a.surface !== b.surface) return false;
  if (a.surface === 'plane' && a.normal !== undefined && b.normal !== undefined)
    return Math.abs(dot3(a.normal, b.normal)) >= 1 - 1e-9 && Math.abs(dot3(sub3(b.centroid, a.centroid), a.normal)) <= tolerance;
  if (a.axis === undefined || b.axis === undefined || a.radius === undefined || b.radius === undefined) return false;
  if (Math.abs(a.radius - b.radius) > tolerance) return false;
  if (a.surface === 'sphere') return distance3(a.axis.origin, b.axis.origin) <= tolerance;
  const offset = sub3(b.axis.origin, a.axis.origin);
  const off = len3(sub3(offset, scale3(a.axis.dir, dot3(offset, a.axis.dir))));
  return a.surface === 'cylinder' && Math.abs(dot3(a.axis.dir, b.axis.dir)) >= 1 - 1e-9 && off <= tolerance;
}

function pickFaces(frame: SolidFaces, p: Vec3): { faces: number[] } | { problem: 'GDT_POINT_NOT_ON_FACE' | 'GDT_FACE_AMBIGUOUS' } {
  const ranked = frame.details.map((face) => ({ face, distance: faceDistance(frame, face, p) })).sort((a, b) => a.distance - b.distance);
  const nearest = ranked[0];
  if (nearest === undefined || nearest.distance > frame.tolerance) return { problem: 'GDT_POINT_NOT_ON_FACE' };
  const close = ranked.filter((entry) => entry.distance <= frame.tolerance);
  if (close.some((entry) => !sameSurface(entry.face, nearest.face, frame.tolerance))) return { problem: 'GDT_FACE_AMBIGUOUS' };
  return { faces: close.map((entry) => entry.face.index) };
}

const describePoint = (p: Vec3): string => `[${p.map((c) => Number(c.toFixed(6))).join(', ')}]`;

/**
 * Faces of an opened solid named by `points` (world points on the faces).
 * @failure see the file header; `pointIndices` names the offending points
 */
export function resolveIn(frame: SolidFaces, points: readonly Vec3[]): ResolvedFeature | FeatureProblem {
  const byPoint: number[][] = [];
  for (const [index, point] of points.entries()) {
    const pick = pickFaces(frame, point);
    if ('problem' in pick) {
      const near = pick.problem === 'GDT_POINT_NOT_ON_FACE';
      return {
        code: pick.problem,
        message: near
          ? `facesNear[${index}] ${describePoint(point)} is farther than ${Number(frame.tolerance.toPrecision(3))} from every face`
          : `facesNear[${index}] ${describePoint(point)} lies on an edge between different surfaces`,
        pointIndices: [index],
      };
    }
    byPoint.push(pick.faces);
  }
  const indices = [...new Set(byPoint.flat())].sort((a, b) => a - b);
  const faces = indices.flatMap((i) => {
    const face = frame.details[i];
    return face === undefined ? [] : [face];
  });
  const surfaces = new Set(faces.map((face) => face.surface));
  const only = faces[0]?.surface;
  return {
    faces,
    surface: surfaces.size === 1 && only !== undefined ? only : 'mixed',
    topology: frame.topology,
    tolerance: frame.tolerance,
    diagonal: frame.diagonal,
    byPoint,
  };
}

/** Faces of `recipe` named by `points`; opens the solid first. */
export function resolveFeature(
  kernel: GeometryKernel | null,
  recipe: ShapeRecipe,
  points: readonly Vec3[],
): ResolvedFeature | FeatureProblem {
  const frame = openSolid(kernel, recipe);
  return 'code' in frame ? frame : resolveIn(frame, points);
}
