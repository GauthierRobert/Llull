/**
 * Shared front end of every feature-attaching pmi command: params (`facesNear`, `placement`), the solid + kernel checks, face resolution and
 * the `PmiFeature` / placement the item stores. Refusals are coded (TECHNICAL_SPEC §7.2).
 */

import type { AnnotationPlacement, PmiFeature, PmiItem } from '../../model/pmi';
import type { CadDocument, Entity, ShapeRecipe, Vec3 } from '../../model/types';
import { is3D } from '../../model/types';
import type { FaceDetail } from '../../geometry/kernelPorts';
import { type ResolvedFeature, isFeatureProblem, resolveFeature } from '../../geometry/pmiFeatures';
import { autoPlacement } from '../../geometry/pmiPlacement';
import { operandRecipe } from '../../geometry/operandRecipe';
import { currentContext } from '../context';
import { vec2, vec3, z } from '../schema';
import type { CommandResult, ExecutionContext } from '../types';
import { pmiItems, refuse } from './pmiOps';

export const facesNearField = z
  .array(vec3('One world point [x, y, z] ON the face (document units), e.g. a point from inspect_faces centroid or samples.'))
  .min(1)
  .describe(
    'World points, one per face of the feature (document units). The faces are re-found from these points at every replay, so PMI follows its ' +
      'face through parametric edits. A pattern of equal holes takes one point on each hole. Use inspect_faces to find points on faces.',
  );

export const placementField = z
  .object({
    origin: vec3('Annotation plane origin [x, y, z], document units.'),
    normal: vec3('Annotation plane unit normal [x, y, z].'),
    xDir: vec3('Annotation plane x direction [x, y, z] (unit, perpendicular to normal).'),
    position: vec2('Frame centre in plane coordinates [u, v], document units.'),
    leaderTo: vec3('Optional leader attachment point on the feature [x, y, z].').optional(),
  })
  .describe(
    'Optional explicit annotation placement; omit for the automatic plane (recomputed when the model changes). An explicit placement is kept.',
  );

type PlacementInput = z.output<typeof placementField>;

/** Placement stored on an item: the explicit one, else the automatic one for `face`. */
export function placementFor(
  doc: CadDocument,
  face: FaceDetail | undefined,
  diagonal: number,
  explicit: PlacementInput | undefined,
): AnnotationPlacement {
  if (explicit !== undefined)
    return {
      plane: { origin: explicit.origin, normal: explicit.normal, xDir: explicit.xDir },
      position: explicit.position,
      ...(explicit.leaderTo === undefined ? {} : { leaderTo: explicit.leaderTo }),
      auto: false,
    };
  const taken = pmiItems(doc).map((item: PmiItem) => item.placement);
  return face === undefined
    ? { plane: { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] }, position: [0, 0], auto: true }
    : autoPlacement(face, diagonal, taken);
}

export interface SolidTarget {
  readonly entity: Entity;
  readonly recipe: ShapeRecipe;
  readonly kernel: NonNullable<ExecutionContext['kernel']>;
}

/** The solid `entityId` and its kernel recipe, or the coded refusal. */
export function solidTarget(
  doc: CadDocument,
  command: string,
  entityId: string,
  ctx: ExecutionContext | undefined,
): SolidTarget | CommandResult {
  const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
  if (entity === undefined || !is3D(entity) || entity.kind === 'instance')
    return refuse(
      doc,
      command,
      'GDT_ENTITY_NOT_SOLID',
      entity === undefined ? `entity '${entityId}' not found` : `entity '${entityId}' (kind '${entity.kind}') is not a 3D solid`,
      [entityId],
      ['entityId'],
    );
  const kernel = (ctx ?? currentContext()).kernel;
  if (kernel === null || kernel.faceQuery === undefined)
    return refuse(
      doc,
      command,
      'GDT_KERNEL_NO_TOPOLOGY',
      'requires the OCC kernel (exact topology and face queries)',
      [entityId],
      ['entityId'],
    );
  return { entity, recipe: operandRecipe(kernel, entity), kernel };
}

export const isRefusal = (value: SolidTarget | CommandResult | ResolvedFeature): value is CommandResult => 'summary' in value;

/** Faces named by `points` on `target`, or the coded refusal (`path` is the param the points came from). */
export function resolveOn(
  doc: CadDocument,
  command: string,
  target: SolidTarget,
  points: readonly Vec3[],
  path: string,
): ResolvedFeature | CommandResult {
  const resolved = resolveFeature(target.kernel, target.recipe, points);
  if (!isFeatureProblem(resolved)) return resolved;
  return refuse(
    doc,
    command,
    resolved.code,
    resolved.message,
    [target.entity.id],
    resolved.pointIndices.length === 0 ? [path] : resolved.pointIndices.map((i) => `${path}.${i}`),
  );
}

/** The `PmiFeature` an item stores for a resolution. */
export function featureOf(entityId: string, points: readonly Vec3[], resolved: ResolvedFeature, ofSize?: PmiFeature['ofSize']): PmiFeature {
  return {
    entityId,
    facesNear: points.map((p): Vec3 => [p[0], p[1], p[2]]),
    faceIndices: resolved.faces.map((face) => face.index),
    surface: resolved.surface,
    ...(ofSize === undefined ? {} : { ofSize }),
  };
}
