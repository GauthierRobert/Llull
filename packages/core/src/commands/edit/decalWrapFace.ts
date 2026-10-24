/**
 * The surface a wrap decal follows (03 WRP M4): the face of the solid under the decal point, read from the exact kernel and expressed in the entity-local frame the decal is stored
 * in. Plane faces need no wrap (a projection of a flat face is exact); sphere, torus and freeform faces cannot carry a decal without stretch.
 * @failure no exact kernel, point off every face, plane / sphere / torus / freeform face -> `{ code, message }`
 */

import type { Entity, Vec3 } from '../../model/types';
import type { DecalSurface } from '../../model/decal';
import { inverseEulerXYZ } from '../../lib/eulerRotation';
import { sub3 } from '../../lib/vec3';
import { operandRecipe } from '../../geometry/operandRecipe';
import { currentContext } from '../context';
import type { ExecutionContext } from '../types';

export interface WrapFace {
  readonly surface: DecalSurface;
  /** The decal point moved onto the face and the outward direction there, both entity-local. */
  readonly center: Vec3;
  readonly normal: Vec3;
  readonly kind: 'cylinder' | 'cone';
  readonly faceIndex: number;
}

export function wrapFaceAt(
  entity: Entity,
  ctx: ExecutionContext | undefined,
  at: Vec3,
): WrapFace | { readonly code: string; readonly message: string } {
  const kernel = (ctx ?? currentContext()).kernel;
  const query = kernel?.faceQuery;
  if (kernel === null || query === undefined)
    return { code: 'CMD_KERNEL_UNAVAILABLE', message: "mapping 'wrap' reads the face under the decal: it needs the exact (native) kernel" };
  const shape = kernel.evaluate(operandRecipe(kernel, entity));
  if (shape === null) return { code: 'WRP_KERNEL_BUILD_FAILED', message: `the kernel could not build '${entity.id}'` };
  const face = query.distance(shape, [at])?.[0]?.face ?? -1;
  const geometry = face < 0 ? null : query.faceGeometry(shape, face);
  const hit = face < 0 ? null : (query.projectOnFace(shape, face, [at])?.[0] ?? null);
  if (geometry === null || hit === null)
    return { code: 'WRP_FACE_NOT_FOUND', message: `no face of '${entity.id}' lies under [${at.join(', ')}]` };
  const local = (point: Vec3): Vec3 => inverseEulerXYZ(sub3(point, entity.position), entity.rotation);
  const direction = (vector: Vec3): Vec3 => inverseEulerXYZ(vector, entity.rotation);
  const { surface } = geometry;
  if (surface.type === 'cylinder')
    return {
      surface: {
        type: 'cylinder',
        origin: local(surface.origin),
        axis: direction(surface.axis),
        xDir: direction(surface.xDir),
        radius: surface.radius,
      },
      center: local(hit.point),
      normal: direction(hit.normal),
      kind: 'cylinder',
      faceIndex: face,
    };
  if (surface.type === 'cone')
    return {
      surface: {
        type: 'cone',
        apex: local(surface.apex),
        axis: direction(surface.axis),
        xDir: direction(surface.xDir),
        semiAngle: surface.semiAngle,
      },
      center: local(hit.point),
      normal: direction(hit.normal),
      kind: 'cone',
      faceIndex: face,
    };
  return {
    code: surface.type === 'plane' ? 'WRP_WRAP_NOT_NEEDED' : 'WRP_FACE_NOT_DEVELOPABLE',
    message:
      surface.type === 'plane'
        ? `face ${face} is flat: a projected decal is already exact there (leave mapping out)`
        : `face ${face} is ${surface.type === 'other' ? 'a freeform surface' : surface.type}: it cannot carry a decal without stretch (only cylinder and cone faces wrap)`,
  };
}
