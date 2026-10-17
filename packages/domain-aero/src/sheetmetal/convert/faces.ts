/** Reads an exact solid's face graph and topology as the planar / cylindrical facts the sheet-metal conversion needs. */

import type { FaceGraph } from '@core/geometry/kernelPorts';
import type { ShapeEdge, ShapeTopology } from '@core/geometry/kernel';
import type { Vec3 } from '@core/model/types';
import { distance3, dot3, normalize3, scale3, sub3 } from '@lib/vec3';

export interface PlaneFacts {
  readonly index: number;
  readonly origin: Vec3;
  /** Unit normal pointing out of the material. */
  readonly outward: Vec3;
  readonly area: number;
}

export interface CylinderFacts {
  readonly index: number;
  readonly origin: Vec3;
  readonly axis: Vec3;
  readonly radius: number;
  /** Angular extent of the face, radians. */
  readonly sweep: number;
  readonly area: number;
}

export interface SolidFacts {
  readonly graph: FaceGraph;
  readonly edges: readonly ShapeEdge[];
  readonly volume: number;
  readonly planes: ReadonlyMap<number, PlaneFacts>;
  readonly cylinders: ReadonlyMap<number, CylinderFacts>;
  /** Face indices of cones, spheres, tori and other surfaces: not developable. */
  readonly other: readonly number[];
}

const TWO_PI = 2 * Math.PI;

export function readSolid(graph: FaceGraph, topology: ShapeTopology): SolidFacts {
  const planes = new Map<number, PlaneFacts>();
  const cylinders = new Map<number, CylinderFacts>();
  const other: number[] = [];
  for (const face of graph.faces) {
    const surface = face.surface;
    if (surface.type === 'plane') {
      const normal = normalize3(surface.normal);
      planes.set(face.index, {
        index: face.index,
        origin: surface.origin,
        outward: face.reversed ? scale3(normal, -1) : normal,
        area: face.area,
      });
    } else if (surface.type === 'cylinder') {
      const [u0, u1] = [face.uvBounds[0], face.uvBounds[1]];
      const sweep = (((u1 - u0) % TWO_PI) + TWO_PI) % TWO_PI || TWO_PI;
      cylinders.set(face.index, {
        index: face.index,
        origin: surface.origin,
        axis: normalize3(surface.axis),
        radius: surface.radius,
        sweep,
        area: face.area,
      });
    } else other.push(face.index);
  }
  return { graph, edges: topology.edges, volume: topology.volume, planes, cylinders, other };
}

/** Distance between the parallel planes of two faces (null when not parallel). */
export function planeGap(a: PlaneFacts, b: PlaneFacts, tolerance = 1e-9): number | null {
  if (Math.abs(Math.abs(dot3(a.outward, b.outward)) - 1) > tolerance) return null;
  return Math.abs(dot3(sub3(b.origin, a.origin), a.outward));
}

const near3 = (a: Vec3, b: Vec3, tolerance: number): boolean => distance3(a, b) <= tolerance;

/** Points of an edge walked from its start (or backward). */
function edgePoints(edge: ShapeEdge, backward: boolean): Vec3[] {
  const points = edge.samples !== undefined && edge.samples.length >= 2 ? [...edge.samples] : [edge.start, edge.end];
  return backward ? points.reverse() : points;
}

export interface Loop3 {
  readonly points: Vec3[];
  /** A single closed circular edge: its fitted circle. */
  readonly circle?: { readonly center: Vec3; readonly radius: number };
}

/**
 * Closed 3D point loop of the edges of a face wire, chained by end points (edge order in the wire is not relied on).
 * @failure edges that do not close into one loop -> null
 */
export function chainLoop(edges: readonly ShapeEdge[], tolerance: number): Loop3 | null {
  const first = edges[0];
  if (first === undefined) return null;
  if (edges.length === 1 && near3(first.start, first.end, tolerance)) {
    const points = edgePoints(first, false).slice(0, -1);
    const count = Math.max(points.length, 1);
    const center = scale3(
      points.reduce<Vec3>((sum, p) => [sum[0] + p[0], sum[1] + p[1], sum[2] + p[2]], [0, 0, 0]),
      1 / count,
    );
    const radius = points.reduce((sum, p) => sum + distance3(p, center), 0) / count;
    return { points, circle: { center, radius } };
  }
  const remaining = edges.slice(1);
  const path: Vec3[] = edgePoints(first, false);
  for (let guard = 0; remaining.length > 0 && guard <= edges.length; guard++) {
    const tail = path[path.length - 1] as Vec3;
    const index = remaining.findIndex((edge) => near3(edge.start, tail, tolerance) || near3(edge.end, tail, tolerance));
    if (index < 0) return null;
    const edge = remaining.splice(index, 1)[0] as ShapeEdge;
    path.push(...edgePoints(edge, !near3(edge.start, tail, tolerance)).slice(1));
  }
  if (remaining.length > 0 || !near3(path[0] as Vec3, path[path.length - 1] as Vec3, tolerance)) return null;
  return { points: path.slice(0, -1) };
}
