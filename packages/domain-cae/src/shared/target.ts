/** Target schema + validation shared by constraints, loads, mesh refinements and thermal BCs. Targets are points; the mesher resolves them. */

import type { AnalysisCase, FeaTarget } from '@core/model/analysis';
import { is3D, type CadDocument } from '@core/model/types';
import { vec3, z } from '@core/commands/schema';

export const feaTargetSchema = z.object({
  entityId: z.string().describe('Id of the analysed 3D entity (it must be a part of the analysis: set_part_idealization).'),
  facesNear: z
    .array(vec3('A point [x, y, z] in document units lying on (or very near) the intended face.'))
    .optional()
    .describe('Points identifying faces: each resolves to the NEAREST face of the entity at meshing time.'),
  edgesNear: z
    .array(vec3('A point [x, y, z] in document units lying on (or very near) the intended edge.'))
    .optional()
    .describe('Points identifying edges: each resolves to the nearest edge.'),
  pointsNear: z
    .array(vec3('A point [x, y, z] in document units lying on (or very near) the intended vertex or location.'))
    .optional()
    .describe('Points identifying vertices / locations: each resolves to the nearest vertex or node.'),
  intersectPlane: z
    .object({ point: vec3('A point on the plane.'), normal: vec3('Plane normal (need not be unit length).') })
    .optional()
    .describe('Optional: restrict the target to the curve where the faces meet this plane.'),
});

export type FeaTargetInput = z.output<typeof feaTargetSchema>;

/** Plain `FeaTarget` from validated input (absent selectors are omitted, never undefined). */
export function toTarget(input: FeaTargetInput): FeaTarget {
  return {
    entityId: input.entityId,
    ...(input.facesNear !== undefined ? { facesNear: input.facesNear } : {}),
    ...(input.edgesNear !== undefined ? { edgesNear: input.edgesNear } : {}),
    ...(input.pointsNear !== undefined ? { pointsNear: input.pointsNear } : {}),
    ...(input.intersectPlane !== undefined ? { intersectPlane: input.intersectPlane } : {}),
  };
}

export interface TargetProblem {
  readonly code: 'FEA_TARGET_UNRESOLVED' | 'FEA_PART_NOT_IN_ANALYSIS';
  readonly message: string;
}

const hasPoints = (points: readonly unknown[] | undefined): boolean => points !== undefined && points.length > 0;

/**
 * Shape + entity-existence check of a target (resolution to topology happens in the mesher).
 * @failure entity missing / not 3D / no selector point -> FEA_TARGET_UNRESOLVED; entity not a part of the case -> FEA_PART_NOT_IN_ANALYSIS
 */
export function targetProblem(doc: CadDocument, analysisCase: AnalysisCase, target: FeaTarget): TargetProblem | null {
  const entity = Object.hasOwn(doc.entities, target.entityId) ? doc.entities[target.entityId] : undefined;
  if (entity === undefined) return { code: 'FEA_TARGET_UNRESOLVED', message: `entity '${target.entityId}' does not exist` };
  if (!is3D(entity))
    return { code: 'FEA_TARGET_UNRESOLVED', message: `entity '${target.entityId}' is 2D (${entity.kind}); targets need a solid` };
  if (!hasPoints(target.facesNear) && !hasPoints(target.edgesNear) && !hasPoints(target.pointsNear))
    return { code: 'FEA_TARGET_UNRESOLVED', message: 'give at least one point in facesNear, edgesNear or pointsNear' };
  if (!Object.hasOwn(analysisCase.parts, target.entityId))
    return { code: 'FEA_PART_NOT_IN_ANALYSIS', message: `entity '${target.entityId}' is not a part of analysis '${analysisCase.id}'` };
  return null;
}
