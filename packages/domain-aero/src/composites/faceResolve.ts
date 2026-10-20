/** Resolves a `faceNear` reference to a part surface + outline (the developed frame, 06 CMP §5.7): analytic primitives on any kernel, other solids via the face-query port. */

import type { PartSurface, Rosette } from '@core/model/composites';
import type { Entity, Vec2, Vec3 } from '@core/model/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { cross3, dot3, len3, normalize3, scale3, sub3 } from '@lib/vec3';
import {
  type CylinderFace,
  type FaceCandidate,
  type ConeFace,
  type PlaneFace,
  arcSteps,
  distanceToFace,
  primitiveFaces,
} from './faceCandidates';

export type FaceResolution =
  | { readonly ok: true; readonly surface: PartSurface; readonly outline: Vec2[]; readonly faceIndex?: number }
  | {
      readonly ok: false;
      readonly code: 'CMP_FACE_NOT_FOUND' | 'CMP_FACE_AMBIGUOUS' | 'CMP_FACE_UNSUPPORTED' | 'CMP_ROSETTE_DEGENERATE';
      readonly message: string;
    };

const fail = (code: Extract<FaceResolution, { ok: false }>['code'], message: string): FaceResolution => ({ ok: false, code, message });

/** Pick tolerance: 1e-3 of the entity's size (min 1e-6) in document units. */
const pickTolerance = (entity: Entity, near: Vec3): number => 1e-6 + 1e-3 * (len3(sub3(near, entity.position)) + 1);

/** Part frame of a plane face: origin = rosette origin projected on the plane, x = rosette 0-degree axis projected, y = n x x. */
function planePart(face: PlaneFace, rosette: Rosette): FaceResolution {
  const n = normalize3(face.normal);
  const onPlane = (v: Vec3): Vec3 => sub3(v, scale3(n, dot3(v, n)));
  const along = onPlane(rosette.axis0);
  if (len3(along) < 1e-9) return fail('CMP_ROSETTE_DEGENERATE', 'the rosette 0-degree axis is parallel to the tool face normal');
  const xDir = normalize3(along);
  const yDir = cross3(n, xDir);
  const origin = sub3(rosette.origin, scale3(n, dot3(sub3(rosette.origin, face.origin), n)));
  const ring3 = face.ring.map(
    ([u, v]): Vec3 => [
      face.origin[0] + face.xDir[0] * u + face.yDir[0] * v,
      face.origin[1] + face.xDir[1] * u + face.yDir[1] * v,
      face.origin[2] + face.xDir[2] * u + face.yDir[2] * v,
    ],
  );
  const outline = ring3.map((p): Vec2 => [dot3(sub3(p, origin), xDir), dot3(sub3(p, origin), yDir)]);
  return { ok: true, surface: { type: 'plane', origin, xDir, yDir, normal: n }, outline };
}

function cylinderPart(face: CylinderFace): FaceResolution {
  const [u0, u1] = face.uRange;
  const [s0, s1] = [face.radius * u0, face.radius * u1];
  return {
    ok: true,
    surface: { type: 'cylinder', origin: face.origin, axis: face.axis, xDir: face.xDir, radius: face.radius },
    outline: [
      [s0, 0],
      [s1, 0],
      [s1, face.length],
      [s0, face.length],
    ],
  };
}

/** Developed sector of a cone face: apex (or the inner arc) and the outer arc, arcs cut at `tolerance` (document units). */
function conePart(face: ConeFace, tolerance: number): FaceResolution {
  const [u0, u1] = face.uRange;
  const k = Math.sin(face.semiAngle);
  const [rho0, rho1] = face.rhoRange;
  const arc = (rho: number, reverse: boolean): Vec2[] => {
    const n = arcSteps(rho, (u1 - u0) * k, tolerance);
    const points = Array.from({ length: n + 1 }, (_, i): Vec2 => {
      const theta = (u0 + ((u1 - u0) * i) / n) * k;
      return [rho * Math.cos(theta), rho * Math.sin(theta)];
    });
    return reverse ? points.reverse() : points;
  };
  const outer = arc(rho1, false);
  const outline = rho0 < 1e-9 ? [[0, 0] as Vec2, ...outer] : [...outer, ...arc(rho0, true)];
  return { ok: true, surface: { type: 'cone', apex: face.apex, axis: face.axis, xDir: face.xDir, semiAngle: face.semiAngle }, outline };
}

function fromCandidate(face: FaceCandidate, rosette: Rosette, tolerance: number): FaceResolution {
  if (face.type === 'plane') return planePart(face, rosette);
  return face.type === 'cylinder' ? cylinderPart(face) : conePart(face, tolerance);
}

/** The best primitive face near `near`: not found / ambiguous when none (or two) lie within `tolerance`. */
function pickPrimitive(faces: readonly FaceCandidate[], near: Vec3, tolerance: number): FaceCandidate | 'none' | 'ambiguous' {
  const ranked = faces.map((face) => ({ face, distance: distanceToFace(face, near) })).sort((a, b) => a.distance - b.distance);
  const best = ranked[0];
  if (best === undefined || best.distance > tolerance) return 'none';
  const second = ranked[1];
  return second !== undefined && second.distance <= tolerance ? 'ambiguous' : best.face;
}

/** A face of a non-primitive solid through the kernel's face-query port (plane, cylinder and cone faces). */
function kernelFace(kernel: GeometryKernel, entity: Entity, near: Vec3, rosette: Rosette, tolerance: number): FaceResolution {
  const port = kernel.faceQuery;
  if (port === undefined)
    return fail('CMP_FACE_UNSUPPORTED', `'${entity.id}' is a ${entity.kind}: faces of this kind need the OCC kernel (face queries)`);
  const shape = kernel.evaluate(recipeOf(entity));
  if (shape === null) return fail('CMP_FACE_UNSUPPORTED', `the kernel cannot build '${entity.id}'`);
  const hit = port.distance(shape, [near])?.[0];
  if (hit === undefined || hit.distance > tolerance)
    return fail('CMP_FACE_NOT_FOUND', `no face of '${entity.id}' lies within ${tolerance} of the point`);
  const geometry = port.faceGeometry(shape, hit.face);
  if (geometry === null) return fail('CMP_FACE_UNSUPPORTED', `the kernel gave no surface description for face ${hit.face}`);
  const { surface, uvBounds } = geometry;
  const [[u0, v0], [u1, v1]] = uvBounds;
  const index = hit.face;
  const withIndex = (resolution: FaceResolution): FaceResolution => (resolution.ok ? { ...resolution, faceIndex: index } : resolution);
  if (surface.type === 'plane') {
    const outward = port.faceDetails(shape)?.find((detail) => detail.index === index)?.normal ?? surface.normal;
    const flipped = dot3(outward, surface.normal) < 0;
    const x = normalize3(surface.xDir);
    const y = cross3(surface.normal, x);
    const rect: Vec2[] = [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ];
    const face: PlaneFace = flipped
      ? {
          type: 'plane',
          origin: surface.origin,
          xDir: x,
          yDir: scale3(y, -1),
          normal: scale3(surface.normal, -1),
          ring: rect.map(([u, v]): Vec2 => [u, -v]).reverse(),
        }
      : { type: 'plane', origin: surface.origin, xDir: x, yDir: y, normal: surface.normal, ring: rect };
    return withIndex(planePart(face, rosette));
  }
  if (surface.type === 'cylinder') {
    const axis = normalize3(surface.axis);
    const origin: Vec3 = [surface.origin[0] + axis[0] * v0, surface.origin[1] + axis[1] * v0, surface.origin[2] + axis[2] * v0];
    return withIndex(
      cylinderPart({
        type: 'cylinder',
        origin,
        axis,
        xDir: normalize3(surface.xDir),
        radius: surface.radius,
        uRange: [u0, u1],
        length: v1 - v0,
      }),
    );
  }
  if (surface.type === 'cone') {
    const ends = port.evaluateFace(shape, index, [
      [u0, v0],
      [u0, v1],
    ]);
    if (ends === null || ends.length < 2) return fail('CMP_FACE_UNSUPPORTED', 'the kernel could not evaluate the cone face');
    const [rhoA, rhoB] = ends.map((end) => len3(sub3(end.point, surface.apex))) as [number, number];
    return withIndex(
      conePart(
        {
          type: 'cone',
          apex: surface.apex,
          axis: normalize3(surface.axis),
          xDir: normalize3(surface.xDir),
          semiAngle: surface.semiAngle,
          uRange: [u0, u1],
          rhoRange: [Math.min(rhoA, rhoB), Math.max(rhoA, rhoB)],
        },
        tolerance,
      ),
    );
  }
  return fail('CMP_FACE_UNSUPPORTED', `face ${index} is a ${surface.type} surface; only plane, cylinder and cone faces are supported`);
}

/**
 * Surface + outline for the face of `entity` nearest `near`.
 * @invariant analytic primitives resolve identically on every kernel; other solids need the kernel's face-query port (OCC)
 * @failure no face within the pick tolerance -> CMP_FACE_NOT_FOUND; two faces within it -> CMP_FACE_AMBIGUOUS; unsupported solid or surface -> CMP_FACE_UNSUPPORTED
 */
export function resolveToolFace(
  entity: Entity,
  near: Vec3,
  rosette: Rosette,
  kernel: GeometryKernel | null,
  arcTolerance: number,
): FaceResolution {
  const tolerance = pickTolerance(entity, near);
  const faces = primitiveFaces(entity, arcTolerance);
  if (faces !== null) {
    const picked = pickPrimitive(faces, near, tolerance);
    if (picked === 'none') return fail('CMP_FACE_NOT_FOUND', `no face of '${entity.id}' lies within ${tolerance} of [${near.join(', ')}]`);
    if (picked === 'ambiguous')
      return fail('CMP_FACE_AMBIGUOUS', `[${near.join(', ')}] lies on an edge of '${entity.id}' (two faces within ${tolerance})`);
    return fromCandidate(picked, rosette, arcTolerance);
  }
  if (kernel === null)
    return fail('CMP_FACE_UNSUPPORTED', `'${entity.id}' is a ${entity.kind}: only box, cylinder and cone faces resolve without a kernel`);
  return kernelFace(kernel, entity, near, rosette, tolerance);
}
