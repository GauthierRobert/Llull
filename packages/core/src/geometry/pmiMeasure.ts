/**
 * Measurement of resolved PMI features straight from exact surface parameters (03 GDT TECHNICAL_SPEC §5.2): sizes of features of size and
 * location / angle between two features. Nominals are measured, never typed. Lengths in document units, angles in degrees.
 * @invariant plane-plane distance needs parallel planes (|n1.n2| >= cos 1e-9); axes group by collinearity so a pattern counts one per axis
 */

import type { MeasuredSizeKind, PmiFeature } from '../model/pmi';
import type { Vec3 } from '../model/types';
import type { ShapeTopology } from './kernel';
import type { FaceDetail } from './kernelPorts';
import { dot3, len3, scale3, sub3 } from '../lib/vec3';

const PARALLEL = 1 - 1e-9;
const RELATIVE_SIZE_TOLERANCE = 1e-6;
const DEGREES = 180 / Math.PI;

export type SizeProblem =
  | { readonly code: 'GDT_NOT_FOS' | 'GDT_SIZE_MIXED'; readonly message: string; readonly faceIndices: readonly number[] }
  | { readonly code: 'GDT_SIZE_KIND_MISMATCH'; readonly message: string; readonly faceIndices: readonly number[] };

export interface MeasuredSize {
  readonly ofSize: NonNullable<PmiFeature['ofSize']>;
  /** Number of distinct features (axes / sphere centres / slabs) in a pattern. */
  readonly count: number;
}

/** Faces grouped by the axis (cylinders), centre (spheres) they share; every other face is its own group. */
function axisGroups(faces: readonly FaceDetail[], tolerance: number): FaceDetail[][] {
  const groups: FaceDetail[][] = [];
  for (const face of faces) {
    const group = groups.find((members) => {
      const first = members[0];
      if (first?.axis === undefined || face.axis === undefined || first.surface !== face.surface) return false;
      const offset = sub3(face.axis.origin, first.axis.origin);
      if (face.surface === 'sphere') return len3(offset) <= tolerance;
      const parallel = Math.abs(dot3(first.axis.dir, face.axis.dir)) >= PARALLEL;
      return parallel && len3(sub3(offset, scale3(first.axis.dir, dot3(offset, first.axis.dir)))) <= tolerance;
    });
    if (group === undefined) groups.push([face]);
    else group.push(face);
  }
  return groups;
}

/** Whether the cylinder face is a bore (material outside the surface): `convex === false` in the exact topology. */
const isInternal = (topology: ShapeTopology, face: FaceDetail): boolean | undefined => {
  const convex = topology.faces[face.index]?.convex;
  return convex === undefined ? undefined : !convex;
};

const withInternal = (kind: 'cylinder' | 'width' | 'sphere', measured: number, internal: boolean | undefined): MeasuredSize['ofSize'] =>
  internal === undefined ? { kind, measured } : { kind, measured, internal };

/**
 * Size of the feature `faces` for `sizeKind`: cylinders (diameter / radius, `measured` = diameter), two opposite parallel planes (width),
 * spheres. A pattern must be uniform.
 */
export function measureSize(
  faces: readonly FaceDetail[],
  sizeKind: MeasuredSizeKind,
  topology: ShapeTopology,
  tolerance: number,
): MeasuredSize | SizeProblem {
  const indices = faces.map((face) => face.index);
  const wrongKind = (found: string): SizeProblem => ({
    code: 'GDT_SIZE_KIND_MISMATCH',
    message: `sizeKind '${sizeKind}' does not match the resolved ${found}`,
    faceIndices: indices,
  });
  if (sizeKind === 'width') {
    const planes = faces.filter((face) => face.surface === 'plane' && face.normal !== undefined);
    if (planes.length !== 2 || faces.length !== 2) {
      const message =
        faces.every((face) => face.surface === 'plane') && faces.length === 1
          ? 'a single plane is not a feature of size'
          : `a width needs exactly two opposite parallel planes, got ${faces.length} face(s)`;
      return { code: 'GDT_NOT_FOS', message, faceIndices: indices };
    }
    const [a, b] = planes as [FaceDetail, FaceDetail];
    const [na, nb] = [a.normal as Vec3, b.normal as Vec3];
    if (dot3(na, nb) > -PARALLEL)
      return { code: 'GDT_NOT_FOS', message: 'the two planes are not opposite and parallel', faceIndices: indices };
    const separation = dot3(sub3(b.centroid, a.centroid), na);
    return { ofSize: withInternal('width', Math.abs(separation), separation > 0), count: 1 };
  }
  const wanted = sizeKind === 'spherical_diameter' || sizeKind === 'spherical_radius' ? 'sphere' : 'cylinder';
  if (faces.some((face) => face.surface !== wanted || face.radius === undefined || face.axis === undefined)) {
    return faces.every((face) => face.surface === 'plane')
      ? { code: 'GDT_NOT_FOS', message: 'a plane is not a feature of size; use add_location_dimension', faceIndices: indices }
      : wrongKind(`surface type (${[...new Set(faces.map((face) => face.surface))].join(', ')})`);
  }
  const radii = faces.map((face) => face.radius as number);
  const first = radii[0] as number;
  if (radii.some((radius) => Math.abs(radius - first) > RELATIVE_SIZE_TOLERANCE * first))
    return { code: 'GDT_SIZE_MIXED', message: 'the faces have different sizes; use one size dimension per size', faceIndices: indices };
  const count = axisGroups(faces, tolerance).length;
  const internal = isInternal(topology, faces[0] as FaceDetail);
  return { ofSize: withInternal(wanted === 'sphere' ? 'sphere' : 'cylinder', 2 * first, internal), count };
}

/** One geometric element of a feature: a plane or an axis (cylinder / cone). */
export type FeatureElement =
  | { readonly type: 'plane'; readonly point: Vec3; readonly normal: Vec3 }
  | { readonly type: 'axis'; readonly point: Vec3; readonly dir: Vec3 };

export type ElementProblem = { readonly code: 'GDT_LOCATION_AMBIGUOUS'; readonly message: string };

/** The single plane or axis a feature stands for; a feature of several distinct elements is ambiguous for a location. */
export function featureElement(faces: readonly FaceDetail[], tolerance: number): FeatureElement | ElementProblem {
  const first = faces[0];
  const ambiguous = (message: string): ElementProblem => ({ code: 'GDT_LOCATION_AMBIGUOUS', message });
  if (first === undefined) return ambiguous('the feature has no face');
  if (first.surface === 'plane' && first.normal !== undefined) {
    const samePlane = faces.every(
      (face) =>
        face.surface === 'plane' &&
        face.normal !== undefined &&
        Math.abs(dot3(face.normal, first.normal as Vec3)) >= PARALLEL &&
        Math.abs(dot3(sub3(face.centroid, first.centroid), first.normal as Vec3)) <= tolerance,
    );
    return samePlane ? { type: 'plane', point: first.centroid, normal: first.normal } : ambiguous('the feature spans several planes');
  }
  if ((first.surface === 'cylinder' || first.surface === 'cone') && first.axis !== undefined) {
    return axisGroups(faces, tolerance).length === 1
      ? { type: 'axis', point: first.axis.origin, dir: first.axis.dir }
      : ambiguous('the feature spans several axes: one location dimension per hole');
  }
  return ambiguous(`a ${first.surface} face has no plane or axis to locate`);
}

export type LocationResult = { readonly measured: number } | { readonly code: 'GDT_LOCATION_INVALID'; readonly message: string };

const invalid = (message: string): LocationResult => ({ code: 'GDT_LOCATION_INVALID', message });

/** Distance between two elements (parallel planes, parallel axes, axis parallel to a plane), document units. */
function distanceBetween(a: FeatureElement, b: FeatureElement): LocationResult {
  const delta = sub3(b.point, a.point);
  if (a.type === 'plane' && b.type === 'plane')
    return Math.abs(dot3(a.normal, b.normal)) >= PARALLEL
      ? { measured: Math.abs(dot3(delta, a.normal)) }
      : invalid('a distance between planes needs parallel planes; use measure angle');
  if (a.type === 'axis' && b.type === 'axis')
    return Math.abs(dot3(a.dir, b.dir)) >= PARALLEL
      ? { measured: len3(sub3(delta, scale3(a.dir, dot3(delta, a.dir)))) }
      : invalid('a distance between axes needs parallel axes; use measure angle');
  const [plane, axis] = a.type === 'plane' ? [a, b] : [b, a];
  if (plane.type !== 'plane' || axis.type !== 'axis') return invalid('unsupported element pair');
  return Math.abs(dot3(axis.dir, plane.normal)) <= 1e-9
    ? { measured: Math.abs(dot3(sub3(axis.point, plane.point), plane.normal)) }
    : invalid('a distance from an axis to a plane needs the axis parallel to the plane');
}

/** Angle in degrees in [0, 90] between two elements (normals, axes, or axis and plane). */
function angleBetween(a: FeatureElement, b: FeatureElement): LocationResult {
  const direction = (e: FeatureElement): Vec3 => (e.type === 'plane' ? e.normal : e.dir);
  const cosine = Math.min(1, Math.abs(dot3(direction(a), direction(b))));
  if (a.type === b.type) return { measured: Math.acos(cosine) * DEGREES };
  return { measured: Math.asin(cosine) * DEGREES };
}

export const locate = (a: FeatureElement, b: FeatureElement, measure: 'distance' | 'angle'): LocationResult =>
  measure === 'distance' ? distanceBetween(a, b) : angleBetween(a, b);
