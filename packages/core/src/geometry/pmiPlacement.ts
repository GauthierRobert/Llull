/**
 * Automatic annotation planes (03 GDT TECHNICAL_SPEC §5.3): where a PMI frame sits in 3D so a reviewer, the viewport and the drawing
 * painter all read the same place. Deterministic: ties go to the world axes in the fixed order Z, X, Y.
 * @invariant plane feature: plane contains the face normal and the world axis most perpendicular to it; cylinder feature: plane perpendicular
 *   to the axis through the face centre; an item stays `auto` until a caller sets `placement` explicitly
 */

import type { AnnotationPlacement } from '../model/pmi';
import type { Vec2, Vec3 } from '../model/types';
import type { FaceDetail } from './kernelPorts';
import { add3, cross3, dot3, normalize3, scale3, sub3 } from '../lib/vec3';

const WORLD_AXES: readonly Vec3[] = [
  [0, 0, 1],
  [1, 0, 0],
  [0, 1, 0],
];

/** Frame height as a fraction of the solid diagonal; frame width is `FRAME_ASPECT` heights. */
const FRAME_HEIGHT_FRACTION = 0.03;
const FRAME_ASPECT = 8;
const OFFSET_FRACTION = 0.15;

/** Removes negative zeros so saved documents are stable. */
const clean = (v: Vec3): Vec3 => [v[0] + 0, v[1] + 0, v[2] + 0];

/** World axis most perpendicular to `n` (ties within 1e-9 go to Z, then X, then Y). */
function mostPerpendicular(n: Vec3): Vec3 {
  let best = WORLD_AXES[0] as Vec3;
  for (const axis of WORLD_AXES) if (Math.abs(dot3(n, axis)) < Math.abs(dot3(n, best)) - 1e-9) best = axis;
  return best;
}

/** Orthonormal in-plane axes for a plane of unit `normal`: x to the right, y up (world Z when it lies in the plane, else world Y). */
export function planeAxes(normal: Vec3): { readonly xDir: Vec3; readonly yDir: Vec3 } {
  const up: Vec3 = Math.abs(dot3(normal, [0, 0, 1])) < 1 - 1e-9 ? [0, 0, 1] : [0, 1, 0];
  const xDir = clean(normalize3(cross3(up, normal)));
  return { xDir, yDir: clean(normalize3(cross3(normal, xDir))) };
}

/** Plane through `origin` for a feature whose surface normal / axis is `direction`. */
function planeFor(face: FaceDetail): { origin: Vec3; normal: Vec3; leaderTo: Vec3 } {
  if (face.surface === 'plane' && face.normal !== undefined) {
    const normal = clean(normalize3(cross3(normalize3(face.normal), mostPerpendicular(normalize3(face.normal)))));
    return { origin: face.centroid, normal, leaderTo: face.centroid };
  }
  if (face.axis !== undefined) {
    const normal = normalize3(face.axis.dir);
    const { xDir } = planeAxes(normal);
    return { origin: face.centroid, normal, leaderTo: add3(face.centroid, scale3(xDir, face.radius ?? 0)) };
  }
  const normal: Vec3 = [0, 1, 0];
  return { origin: face.centroid, normal, leaderTo: face.centroid };
}

/** Whether `a` and `b` frames (centres, plane coordinates) overlap given the frame size. */
const overlaps = (a: Vec2, b: Vec2, width: number, height: number): boolean =>
  Math.abs(a[0] - b[0]) < width && Math.abs(a[1] - b[1]) < height;

/** Whether two placements lie in the same plane (parallel normals, same offset along it). */
function samePlane(a: AnnotationPlacement['plane'], b: AnnotationPlacement['plane'], tolerance: number): boolean {
  return Math.abs(dot3(a.normal, b.normal)) >= 1 - 1e-9 && Math.abs(dot3(sub3(b.origin, a.origin), a.normal)) <= tolerance;
}

/**
 * Placement of a PMI frame for `face` (the first face of the feature), offset 0.15 x diagonal along the face normal projected on the plane,
 * then moved along plane x by one frame height until it no longer overlaps an item of `taken` in the same plane.
 */
export function autoPlacement(face: FaceDetail, diagonal: number, taken: readonly AnnotationPlacement[]): AnnotationPlacement {
  const { origin, normal, leaderTo } = planeFor(face);
  const { xDir, yDir } = planeAxes(normal);
  const plane = { origin, normal, xDir };
  const height = FRAME_HEIGHT_FRACTION * diagonal;
  const width = FRAME_ASPECT * height;
  const direction = face.normal === undefined ? ([1, 1, 0] as const) : ([dot3(face.normal, xDir), dot3(face.normal, yDir), 0] as const);
  const length = Math.hypot(direction[0], direction[1]);
  const push = OFFSET_FRACTION * diagonal;
  let position: Vec2 = length < 1e-9 ? [push, push] : [(push * direction[0]) / length, (push * direction[1]) / length];
  const peers = taken.filter((other) => samePlane(plane, other.plane, 1e-6 * (1 + diagonal)));
  for (let guard = 0; guard < 1000 && peers.some((other) => overlaps(position, other.position, width, height)); guard++)
    position = [position[0] + height, position[1]];
  return { plane, position, leaderTo, auto: true };
}

/** Frame centre of `placement` in world coordinates (for projection onto a sheet view). */
export function frameAnchor(placement: AnnotationPlacement): Vec3 {
  const { plane, position } = placement;
  const yDir = normalize3(cross3(plane.normal, plane.xDir));
  return add3(add3(plane.origin, scale3(plane.xDir, position[0])), scale3(yDir, position[1]));
}
