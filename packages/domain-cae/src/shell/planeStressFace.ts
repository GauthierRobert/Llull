/**
 * Source faces of a plane-stress part (05 §3 `plane_stress`): the planar faces nearest to `sourceFacesNear`, which must lie in the plane z = 0
 * (CalculiX plane elements are defined in the global x-y plane). Boxes are read analytically; other solids need the exact kernel faces.
 */

import type { GeometryKernel } from '@core/geometry/kernel';
import { entityLocalToWorld } from '@core/geometry/entityFrame';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { is3D, type BoxEntity, type CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from '@lib/vec3';
import { planarLoops } from './faceLoops';
import { orientedAbout } from './sheetMetalMid';
import type { MidFace, Midsurface, MidsurfaceRefusal } from './types';

const PLUS_Z: Vec3 = [0, 0, 1];
/** A face lies in z = 0 when every vertex is within this fraction of the face size of it, and its normal is within 1e-6 of +-Z. */
const PLANE_TOLERANCE = 1e-6;

/** The six faces of a box as world rectangles. */
function boxFaces(entity: BoxEntity): Vec3[][] {
  const faces: Vec3[][] = [];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [-1, 1]) {
      const i = (axis + 1) % 3;
      const j = (axis + 2) % 3;
      const corner = (si: number, sj: number): Vec3 => {
        const local: [number, number, number] = [0, 0, 0];
        local[axis] = (side * (entity.size[axis] ?? 0)) / 2;
        local[i] = (si * (entity.size[i] ?? 0)) / 2;
        local[j] = (sj * (entity.size[j] ?? 0)) / 2;
        return entityLocalToWorld(entity, local);
      };
      faces.push([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]);
    }
  return faces;
}

/** Distance from `point` to the parallelogram c0, c1, c2, c3. */
function rectangleDistance(point: Vec3, corners: readonly Vec3[]): number {
  const [c0 = PLUS_Z, c1 = PLUS_Z, , c3 = PLUS_Z] = corners;
  const e1 = sub3(c1, c0);
  const e2 = sub3(c3, c0);
  const d = sub3(point, c0);
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  const u = clamp(dot3(d, e1) / dot3(e1, e1));
  const v = clamp(dot3(d, e2) / dot3(e2, e2));
  return len3(sub3(point, add3(c0, add3(scale3(e1, u), scale3(e2, v)))));
}

function inPlaneZ0(face: MidFace, size: number): boolean {
  return (
    Math.abs(Math.abs(face.normal[2]) - 1) <= PLANE_TOLERANCE &&
    [face.outer, ...face.holes].every((loop) => loop.every((point) => Math.abs(point[2]) <= PLANE_TOLERANCE * Math.max(1, size)))
  );
}

function sourceFaces(
  doc: CadDocument,
  entityId: string,
  points: readonly Vec3[],
  thickness: number,
  kernel: GeometryKernel | null,
): MidFace[] | MidsurfaceRefusal {
  const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
  if (entity === undefined || !is3D(entity))
    return { code: 'FEA_PART_INVALID', message: `'${entityId}' is not a 3D solid of the document` };
  if (entity.kind === 'box') {
    const rectangles = boxFaces(entity);
    const chosen = new Set(
      points.map((point) =>
        rectangles.reduce(
          (best, face, index) => (rectangleDistance(point, face) < rectangleDistance(point, rectangles[best] ?? face) ? index : best),
          0,
        ),
      ),
    );
    return [...chosen].map((index) => {
      const outer = rectangles[index] ?? [];
      const [c0 = PLUS_Z, c1 = PLUS_Z, , c3 = PLUS_Z] = outer;
      return { outer, holes: [], normal: normalize3(cross3(sub3(c1, c0), sub3(c3, c0))), thickness, source: `box face ${index}` };
    });
  }
  const shape = kernel?.faceQuery === undefined ? null : kernel.evaluate(recipeOf(entity));
  const found = shape === null ? null : (kernel?.faceQuery?.distance(shape, points) ?? null);
  const details = shape === null ? null : (kernel?.faceQuery?.faceDetails(shape) ?? null);
  if (shape === null || found === null || details === null)
    return {
      code: 'FEA_KERNEL_OCC_REQUIRED',
      message: `the plane-stress faces of '${entityId}' need the exact OCC kernel (boxes need none)`,
    };
  const faces: MidFace[] = [];
  for (const index of [...new Set(found.map((hit) => hit.face))]) {
    const detail = details.find((face) => face.index === index);
    const mesh = kernel?.faceQuery?.tessellateFace(shape, index, 1e-3) ?? null;
    const loops = detail?.surface !== 'plane' || detail.normal === undefined || mesh === null ? null : planarLoops(mesh, PLUS_Z);
    if (loops === null) return { code: 'FEA_PLANE_STRESS_NOT_XY', message: `face ${index} of '${entityId}' is not a planar face` };
    faces.push({
      outer: loops.outer,
      holes: loops.holes,
      normal: normalize3(detail?.normal ?? PLUS_Z),
      thickness,
      source: `face ${index}`,
    });
  }
  return faces;
}

/**
 * Plane-stress domain of `entityId`: the faces nearest to `points`, oriented +Z, thickness `thickness` (document units).
 * @failure a face not in z = 0 or not normal to Z -> FEA_PLANE_STRESS_NOT_XY; non-box without the exact kernel -> FEA_KERNEL_OCC_REQUIRED
 */
export function planeStressDomain(
  doc: CadDocument,
  entityId: string,
  points: readonly Vec3[],
  thickness: number,
  kernel: GeometryKernel | null,
): Midsurface | MidsurfaceRefusal {
  const faces = sourceFaces(doc, entityId, points, thickness, kernel);
  if (!Array.isArray(faces)) return faces;
  const size = Math.max(1, ...faces.flatMap((face) => face.outer.map((point) => Math.hypot(...point))));
  const bad = faces.find((face) => !inPlaneZ0(face, size));
  if (bad !== undefined)
    return {
      code: 'FEA_PLANE_STRESS_NOT_XY',
      message: `${bad.source} of '${entityId}' does not lie in the plane z = 0 (CalculiX plane-stress elements are defined in the global x-y plane): model the section on z = 0`,
    };
  const upward = faces.map((face) => ({
    ...face,
    outer: orientedAbout(face.outer, PLUS_Z),
    holes: face.holes.map((hole) => orientedAbout(hole, PLUS_Z).reverse()),
    normal: PLUS_Z,
  }));
  return { entityId, method: 'source_face', faces: upward, thicknesses: [thickness], coverage: 1, unpairedFaces: [], warnings: [] };
}
