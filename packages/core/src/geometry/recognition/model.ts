/**
 * The recognition working model: faces merged into analytic-surface groups (a periodic cylinder or cone often arrives as 2 half faces, §5.6
 * step 1) with their boundary edges. Pure over `FaceGraph` + `ShapeTopology`.
 * @invariant group ids are the smallest member face index; a seam / internal edge (both faces in one group, or a single face) is not a boundary
 */

import type { ShapeTopology } from '../kernel';
import type { FaceGraph, SurfaceParams } from '../kernelPorts';
import type { Vec3 } from '../../model/types';
import { cross3, dot3, len3, sub3 } from '../../lib/vec3';

const TURN = 2 * Math.PI;

export interface Group {
  readonly id: number;
  readonly faces: readonly number[];
  readonly surface: SurfaceParams;
  /** The group's material lies on the outer side of its surface (a bore, a concave fillet); false for planes. */
  readonly reversed: boolean;
  /** Outward unit normal of a planar group, null otherwise. */
  readonly outward: Vec3 | null;
  /** Angular extent in radians of a cylinder / cone / torus, at most 2 pi. */
  readonly span: number;
}

interface Boundary {
  readonly edge: number;
  readonly other: Group;
  readonly convexity: FaceGraph['edgeConvexity'][number];
}

export interface Tolerance {
  readonly length: number;
  readonly angle: number;
}

/**
 * What the kernel knows about face orientation. The raw `FaceGraphFace.reversed` flag is relative to the surface's own parametrisation,
 * which a swept (revolved, extruded) face may mirror, so recognition prefers these answers when it has them.
 */
export interface Orientation {
  /** Outward unit normal of a planar face. */
  readonly outward: (face: number) => Vec3 | null;
  /** Whether the material lies on the outer side of a curved face (a bore, a concave fillet). */
  readonly cavity: (face: number) => boolean | null;
}

export interface Model {
  readonly graph: FaceGraph;
  readonly topology: ShapeTopology;
  readonly tolerance: Tolerance;
  readonly groups: readonly Group[];
  readonly groupOf: (face: number) => Group;
  readonly boundary: (group: Group) => readonly Boundary[];
  /** Start, middle and end (and samples) of an edge. */
  readonly edgePoints: (edge: number) => readonly Vec3[];
}

const parallel = (a: Vec3, b: Vec3, angle: number): boolean => 1 - Math.abs(dot3(a, b)) < angle * angle;

/** Distance of `point` from the line through `origin` along unit `axis`. */
export const distanceToAxis = (point: Vec3, origin: Vec3, axis: Vec3): number => len3(cross3(sub3(point, origin), axis));

function sameSurface(a: SurfaceParams, b: SurfaceParams, normalA: Vec3 | null, normalB: Vec3 | null, tolerance: Tolerance): boolean {
  const { length, angle } = tolerance;
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'plane':
      return (
        b.type === 'plane' &&
        normalA !== null &&
        normalB !== null &&
        dot3(normalA, normalB) > 1 - angle * angle &&
        Math.abs(dot3(normalA, sub3(b.origin, a.origin))) < length
      );
    case 'cylinder':
      return (
        b.type === 'cylinder' &&
        parallel(a.axis, b.axis, angle) &&
        Math.abs(a.radius - b.radius) < length &&
        distanceToAxis(b.origin, a.origin, a.axis) < length
      );
    case 'cone':
      return (
        b.type === 'cone' &&
        dot3(a.axis, b.axis) > 1 - angle * angle &&
        Math.abs(a.semiAngle - b.semiAngle) < angle &&
        len3(sub3(a.apex, b.apex)) < length
      );
    case 'sphere':
      return b.type === 'sphere' && Math.abs(a.radius - b.radius) < length && len3(sub3(a.center, b.center)) < length;
    case 'torus':
      return (
        b.type === 'torus' &&
        parallel(a.axis, b.axis, angle) &&
        Math.abs(a.major - b.major) < length &&
        Math.abs(a.minor - b.minor) < length &&
        len3(sub3(a.center, b.center)) < length
      );
    case 'other':
      return false;
  }
}

/** Union-find roots, smallest member as root. */
function roots(count: number, pairs: ReadonlyArray<readonly [number, number]>): number[] {
  const parent = Array.from({ length: count }, (_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    return root;
  };
  for (const [a, b] of pairs) {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  return parent.map((_, i) => find(i));
}

const angularSpan = (bounds: readonly [number, number, number, number]): number => bounds[1] - bounds[0];

export function buildModel(
  graph: FaceGraph,
  topology: ShapeTopology,
  mergeSplitFaces: boolean,
  tolerance: Tolerance,
  orientation?: Orientation,
): Model {
  const faces = graph.faces;
  const outwardOf = (face: number): Vec3 | null => {
    const surface = faces[face]?.surface;
    if (surface?.type !== 'plane') return null;
    const flipped = faces[face]?.reversed === true;
    return orientation?.outward(face) ?? (flipped ? [-surface.normal[0], -surface.normal[1], -surface.normal[2]] : surface.normal);
  };
  const cavityOf = (face: number): boolean =>
    faces[face]?.surface.type === 'plane' ? false : (orientation?.cavity(face) ?? faces[face]?.reversed ?? false);
  const adjacent: Array<readonly [number, number]> = [];
  graph.edgeFaces.forEach((pair) => {
    const [a, b] = pair;
    if (pair.length !== 2 || a === undefined || b === undefined || a === b) return;
    const [first, second] = [faces[a], faces[b]];
    if (
      mergeSplitFaces &&
      first &&
      second &&
      cavityOf(a) === cavityOf(b) &&
      sameSurface(first.surface, second.surface, outwardOf(a), outwardOf(b), tolerance)
    )
      adjacent.push([a, b]);
  });
  const rootOf = roots(faces.length, adjacent);
  const members = new Map<number, number[]>();
  rootOf.forEach((root, face) => members.set(root, [...(members.get(root) ?? []), face]));
  const groups: Group[] = [...members.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, indices]) => {
      const first = faces[id];
      const span = Math.min(
        TURN,
        indices.reduce((sum, index) => sum + angularSpan(faces[index]?.uvBounds ?? [0, 0, 0, 0]), 0),
      );
      return {
        id,
        faces: indices,
        surface: first?.surface ?? { type: 'other', kind: 'other' },
        reversed: cavityOf(id),
        outward: outwardOf(id),
        span,
      };
    });
  const byId = new Map(groups.map((group) => [group.id, group]));
  const groupOf = (face: number): Group => byId.get(rootOf[face] ?? face) as Group;
  const boundaryCache = new Map<number, Boundary[]>();
  const boundary = (group: Group): Boundary[] => {
    const cached = boundaryCache.get(group.id);
    if (cached !== undefined) return cached;
    const found: Boundary[] = [];
    const seen = new Set<number>();
    for (const face of group.faces)
      for (const loop of faces[face]?.loops ?? [])
        for (const edge of loop) {
          const pair = graph.edgeFaces[edge] ?? [];
          if (seen.has(edge) || pair.length !== 2) continue;
          seen.add(edge);
          const others = pair.filter((index) => groupOf(index) !== group);
          const other = others.length === 1 ? groupOf(others[0] as number) : undefined;
          if (other !== undefined) found.push({ edge, other, convexity: graph.edgeConvexity[edge] ?? 'unknown' });
        }
    boundaryCache.set(group.id, found);
    return found;
  };
  const edgePoints = (edge: number): readonly Vec3[] => {
    const e = topology.edges[edge];
    return e === undefined ? [] : [e.start, e.mid, e.end, ...(e.samples ?? [])];
  };
  return { graph, topology, tolerance, groups, groupOf, boundary, edgePoints };
}

/** Outward unit normal of a planar group. */
export const outwardNormal = (group: Group): Vec3 | null => group.outward;

/** All edge indices of the group's faces. */
export function edgesOf(model: Model, group: Group): number[] {
  return [...new Set(group.faces.flatMap((face) => (model.graph.faces[face]?.loops ?? []).flat()))];
}
