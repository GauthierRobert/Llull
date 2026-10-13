/**
 * Orthographic projection of solids onto a view plane — the one engine behind every technical view (the 2D viewport's top view, elevations,
 * sections): front/back faces, feature + silhouette edges and the cut by a section plane.
 */

import type { Vec2, Vec3 } from '../model/vectors';
import type { Triangle } from './triangles';
import { toRadians } from '../lib/angle';
import { cross3, dot3, sub3 } from '../lib/vec3';
import { boundsOfPoints } from './bounds';
import { quantizedKey } from '../lib/quantize';
import { type UnitPlane, planeChords } from './planeEdges';

/** A view: the unit direction toward the viewer and the map of a world point onto the sheet. */
export interface ViewFrame {
  readonly toViewer: Vec3;
  readonly project: (point: Vec3) => Vec2;
}

/** Plan view: looking down −Z, sheet axes = world X, Y. */
export const TOP_VIEW: ViewFrame = { toViewer: [0, 0, 1], project: (p) => [p[0], p[1]] };

export type Segment2 = readonly [Vec2, Vec2];

export interface Face {
  readonly triangle: Triangle;
  readonly normal: Vec3;
  /** Faces the viewer (normal · toViewer > 0). */
  readonly front: boolean;
}

const FEATURE_COS = Math.cos(toRadians(25));

/** Distance of `point` toward the viewer. */
export const depthOf = (frame: ViewFrame, point: Vec3): number => dot3(point, frame.toViewer);

function unitNormal(triangle: Triangle): Vec3 | null {
  const normal = cross3(sub3(triangle[1], triangle[0]), sub3(triangle[2], triangle[0]));
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  return length > 1e-12 ? [normal[0] / length, normal[1] / length, normal[2] / length] : null;
}

/** Non-degenerate triangles with their normals, flagged front / back for `frame`. */
export function facesOf(triangles: ReadonlyArray<Triangle>, frame: ViewFrame): Face[] {
  const faces: Face[] = [];
  for (const triangle of triangles) {
    const normal = unitNormal(triangle);
    if (normal) faces.push({ triangle, normal, front: dot3(normal, frame.toViewer) > 1e-6 });
  }
  return faces;
}

/** The section plane of `frame` at `cutDepth`: its positive side (toward the viewer) is removed. */
export const sectionPlane = (frame: ViewFrame, cutDepth: number): UnitPlane => ({ normal: [...frame.toViewer], offset: cutDepth });

/** Welding distance for a face set: one millionth of its size, so millimetre and metre documents weld alike. */
export function weldTolerance(faces: ReadonlyArray<Face>): number {
  const { min, max } = boundsOfPoints(faces.flatMap((face) => [...face.triangle]));
  const size = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return Number.isFinite(size) && size > 0 ? size * 1e-6 : 1e-9;
}

/** A drawable edge: a crease sharper than 25°, an open boundary, or a front/back silhouette. */
export interface FeatureEdge {
  readonly a: Vec3;
  readonly b: Vec3;
}

/** Feature, boundary and silhouette edges of a face set (shared edges welded at `tolerance`). */
export function featureEdges(faces: ReadonlyArray<Face>, tolerance: number): FeatureEdge[] {
  const pointKey = (p: Vec3): string => quantizedKey(p, tolerance);
  const byEdge = new Map<string, { a: Vec3; b: Vec3; faces: number[] }>();
  faces.forEach((face, index) => {
    for (let corner = 0; corner < 3; corner++) {
      const a = face.triangle[corner] as Vec3;
      const b = face.triangle[(corner + 1) % 3] as Vec3;
      const [ka, kb] = [pointKey(a), pointKey(b)];
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const entry = byEdge.get(key);
      if (entry) entry.faces.push(index);
      else byEdge.set(key, { a, b, faces: [index] });
    }
  });
  const edges: FeatureEdge[] = [];
  for (const { a, b, faces: adjacent } of byEdge.values()) {
    const fronts = adjacent.filter((index) => (faces[index] as Face).front);
    const [first, second] = [faces[adjacent[0] as number], faces[adjacent[1] as number]];
    const feature =
      adjacent.length !== 2 ||
      fronts.length === 1 ||
      (first !== undefined && second !== undefined && dot3(first.normal, second.normal) < FEATURE_COS);
    if (feature) edges.push({ a, b });
  }
  return edges;
}

/** Segments where the faces cross the section plane depth = `cutDepth`, projected. */
export function cutSegments(faces: ReadonlyArray<Face>, frame: ViewFrame, cutDepth: number): Segment2[] {
  return planeChords(
    faces.map((face) => face.triangle),
    sectionPlane(frame, cutDepth),
  ).map(([a, b]): Segment2 => [frame.project(a), frame.project(b)]);
}
