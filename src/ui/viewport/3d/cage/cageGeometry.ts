// Overlay vertex buffers of a subdivision cage (entity-local coordinates). Pure: entity in, Float32Array out; the components wrap them
// in BufferGeometry once per entity version.

import type { SubdivisionEntity, Vec3 } from '@core/model/types';
import { buildTopology } from '@core/geometry/subd/topology';
import { walkRing, isRingProblem } from '@core/geometry/subd/loops';
import { lerp3 } from '@lib/vec3';
import { type CageSelection, parseEdgeId, selectionVertexIndices } from './cageSelection';

const vertexAt = (entity: SubdivisionEntity, index: number): Vec3 => entity.vertices[index] as Vec3;

function pushSegment(out: number[], a: Vec3, b: Vec3): void {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

/** Every cage edge as a line segment pair. */
export function cageSegments(entity: SubdivisionEntity): Float32Array {
  const out: number[] = [];
  for (const { a, b } of buildTopology(entity.vertices.length, entity.faces).edges)
    pushSegment(out, vertexAt(entity, a), vertexAt(entity, b));
  return new Float32Array(out);
}

/** Crease display: infinitely sharp edges and semi-sharp edges (`0 < s < 10`) as separate segment lists. */
export function creaseSegments(entity: SubdivisionEntity): { sharp: Float32Array; semi: Float32Array } {
  const [sharp, semi]: [number[], number[]] = [[], []];
  for (const [a, b] of entity.creases) pushSegment(sharp, vertexAt(entity, a), vertexAt(entity, b));
  for (const { a, b } of entity.edgeSharpness ?? []) pushSegment(semi, vertexAt(entity, a), vertexAt(entity, b));
  return { sharp: new Float32Array(sharp), semi: new Float32Array(semi) };
}

/** Positions of the cage vertices at `indices` (all when omitted). */
export function vertexPositions(entity: SubdivisionEntity, indices?: readonly number[]): Float32Array {
  const picked = indices ?? entity.vertices.map((_, i) => i);
  const out = new Float32Array(picked.length * 3);
  picked.forEach((v, i) => out.set(vertexAt(entity, v), i * 3));
  return out;
}

/** Segments of the selected edges plus the boundary of the selected faces. */
export function selectedSegments(entity: SubdivisionEntity, selection: CageSelection): Float32Array {
  const out: number[] = [];
  const indexOf = new Map(entity.elementIds.vertices.map((id, index) => [id, index] as const));
  for (const id of selection.edges) {
    const ends = parseEdgeId(id);
    const [a, b] = ends === null ? [undefined, undefined] : [indexOf.get(ends[0]), indexOf.get(ends[1])];
    if (a !== undefined && b !== undefined) pushSegment(out, vertexAt(entity, a), vertexAt(entity, b));
  }
  for (const faceId of selection.faces) {
    const face = entity.faces[entity.elementIds.faces.indexOf(faceId)];
    face?.forEach((v, i) => pushSegment(out, vertexAt(entity, v), vertexAt(entity, face[(i + 1) % face.length] as number)));
  }
  return new Float32Array(out);
}

/** Fan triangles of the selected faces (filled highlight). */
export function selectedFaceTriangles(entity: SubdivisionEntity, selection: CageSelection): Float32Array {
  const out: number[] = [];
  for (const faceId of selection.faces) {
    const face = entity.faces[entity.elementIds.faces.indexOf(faceId)];
    if (face === undefined) continue;
    for (let k = 1; k + 1 < face.length; k++) {
      for (const v of [face[0], face[k], face[k + 1]]) out.push(...vertexAt(entity, v as number));
    }
  }
  return new Float32Array(out);
}

/** Selected vertex indices (for the point highlight). */
export const selectedVertexPositions = (entity: SubdivisionEntity, selection: CageSelection): Float32Array =>
  vertexPositions(entity, selectionVertexIndices(entity, selection));

/**
 * The closed polyline a loop cut through edge `edgeId` would add, as segments: the points at `factor` along each crossed edge, joined
 * across the strip faces. Empty when the strip hits an n-gon or the edge is unknown.
 */
export function loopCutSegments(entity: SubdivisionEntity, edgeId: string, factor = 0.5): Float32Array {
  const ends = parseEdgeId(edgeId);
  if (ends === null) return new Float32Array(0);
  const a = entity.elementIds.vertices.indexOf(ends[0]);
  const b = entity.elementIds.vertices.indexOf(ends[1]);
  if (a < 0 || b < 0) return new Float32Array(0);
  const ring = walkRing(buildTopology(entity.vertices.length, entity.faces), a, b);
  if (isRingProblem(ring)) return new Float32Array(0);
  const points = ring.edges.map(([s, t]) => lerp3(vertexAt(entity, s), vertexAt(entity, t), factor));
  const out: number[] = [];
  points.forEach((p, i) => pushSegment(out, p, points[(i + 1) % points.length] as Vec3));
  return new Float32Array(out);
}

export interface SymmetryPlane {
  readonly axis: 'x' | 'y' | 'z';
  /** Two triangles of the plane quad, entity-local. */
  readonly triangles: Float32Array;
  /** Outline segments of the quad. */
  readonly outline: Float32Array;
}

/** The mirror planes of the cage as quads covering the cage bounds (10 % margin). */
export function symmetryPlanes(entity: SubdivisionEntity): SymmetryPlane[] {
  if (entity.symmetry === undefined || entity.vertices.length === 0) return [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of entity.vertices) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, v[k] as number);
      max[k] = Math.max(max[k] as number, v[k] as number);
    }
  }
  const half = Math.max(...max.map((m, k) => Math.max(Math.abs(m), Math.abs(min[k] as number)))) * 1.1 || 1;
  return entity.symmetry.planes.map((axis) => {
    const corner = (u: number, v: number): Vec3 => (axis === 'x' ? [0, u, v] : axis === 'y' ? [u, 0, v] : [u, v, 0]);
    const [p0, p1, p2, p3] = [corner(-half, -half), corner(half, -half), corner(half, half), corner(-half, half)];
    const triangles = new Float32Array([...p0, ...p1, ...p2, ...p0, ...p2, ...p3]);
    const outline: number[] = [];
    [p0, p1, p2, p3].forEach((p, i) => pushSegment(outline, p, [p1, p2, p3, p0][i] as Vec3));
    return { axis, triangles, outline: new Float32Array(outline) };
  });
}
