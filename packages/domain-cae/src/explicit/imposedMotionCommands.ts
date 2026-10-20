/** add_imposed_motion / delete_imposed_motion: prescribed velocity or displacement histories of an explicit case (§3 imposedMotions, RS-8). */

import type { ExplicitImposedMotion, ExplicitSpec } from '@core/model/explicit';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { analysisIdSchema } from '../shared/schemas';
import { refuseExplicit } from './codes';
import { explicitCase, supportedUnits, withSpec } from './model';

/**
 * @affects doc.analysis.cases[analysisId].explicit.imposedMotions (adds 1 motion; affected: [analysisId, motionId])
 * @invariant ids `im-<step>.<k>`; curve values stored in the case units (length/s or length), times in s
 * @failure unknown / non-explicit case / no controls -> FEA_ANALYSIS_NOT_FOUND / EXP_CASE_TYPE / EXP_CONTROLS_MISSING; target entity not a
 *   part of the case or without facesNear / pointsNear -> EXP_TARGET_NOT_IN_CASE / EXP_PARAM_INVALID; empty curve, times not increasing,
 *   non-finite values -> EXP_CURVE_INVALID; unsupported case unit system -> EXP_UNITS_UNSUPPORTED; a unit that is not a velocity / length ->
 *   EXP_PARAM_INVALID
 */
export const addImposedMotion = defineCommand({
  name: 'add_imposed_motion',
  description:
    'Prescribe the motion of one translational dof (x, y or z) of the nodes of a part face or near points in an explicit_dynamics case ' +
    '(llull_explicit): kind velocity gives v(t), kind displacement gives the displacement u(t) from the start position; the curve is ' +
    '[[time s, value], ...] (piecewise linear, constant outside its range) in `unit` (mm/s, m/s for velocity; mm, m for displacement). ' +
    'The target is a part of the case with points near a box face (all its nodes on that plane) or near nodes. A dof can carry one motion. ' +
    'Returns the motion id in affected[1].',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z.string().min(1).describe('Name, e.g. "punch".'),
    target: z
      .object({
        entityId: z.string().describe('Id of a part of the case.'),
        facesNear: z
          .array(vec3('A point [x, y, z] in document units on (or near) a box face of the part.'))
          .optional()
          .describe('Faces: all the part nodes on the nearest box face plane.'),
        pointsNear: z.array(vec3('A point [x, y, z] in document units.')).optional().describe('Nodes: the part node nearest each point.'),
      })
      .describe('Where the motion acts (give facesNear and / or pointsNear).'),
    dof: z.enum(['x', 'y', 'z']).describe('Translational dof the curve drives.'),
    kind: z.enum(['velocity', 'displacement']).optional().describe('What the curve gives; default velocity.'),
    curve: z.array(z.tuple([z.number(), z.number()])).describe('[[time s, value], ...], times strictly increasing.'),
    unit: z.string().describe('Unit of the curve values: a velocity (mm/s, m/s) or a length (mm, m) for displacement.'),
  }),
  run: (doc, { analysisId, name, target, dof, kind = 'velocity', curve, unit }): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseExplicit(doc, 'add_imposed_motion', code, message, [analysisId], paths);
    const found = explicitCase(doc, analysisId);
    if ('code' in found) return fail(found.code, found.message);
    const { analysisCase, spec } = found;
    if (spec === undefined) return fail('EXP_CONTROLS_MISSING', `analysis '${analysisId}' has no explicit controls yet`);
    if (!Object.hasOwn(analysisCase.parts, target.entityId))
      return fail('EXP_TARGET_NOT_IN_CASE', `'${target.entityId}' is not a part of '${analysisId}'`, ['target.entityId']);
    if ((target.facesNear ?? []).length === 0 && (target.pointsNear ?? []).length === 0)
      return fail('EXP_PARAM_INVALID', 'give facesNear or pointsNear', ['target']);
    if (
      curve.length === 0 ||
      !curve.every(([t, v]) => Number.isFinite(t) && Number.isFinite(v)) ||
      curve.some(([t], k) => k > 0 && !(t > (curve[k - 1]?.[0] ?? t)))
    )
      return fail('EXP_CURVE_INVALID', 'the curve needs at least one point, finite values and strictly increasing times', ['curve']);
    const units = supportedUnits(analysisCase);
    if (units === null) return fail('EXP_UNITS_UNSUPPORTED', `unit system ${analysisCase.unitSystem} is not supported by llull_explicit`);
    const caseUnit = kind === 'velocity' ? `${units.length}/s` : units.length;
    const values = curve.map(([, value]) => convertValue(value, unit, caseUnit));
    if (values.some((value) => isUnitFailure(value)))
      return fail('EXP_PARAM_INVALID', `'${unit}' is not a ${kind === 'velocity' ? 'velocity' : 'length'} unit`, ['unit']);
    const converted = curve.map(([t], k) => {
      const value = values[k];
      return [t, value === undefined || isUnitFailure(value) ? 0 : value.value] as const;
    });
    const motion: ExplicitImposedMotion = {
      name,
      target: {
        entityId: target.entityId,
        ...(target.facesNear !== undefined ? { facesNear: target.facesNear } : {}),
        ...(target.pointsNear !== undefined ? { pointsNear: target.pointsNear } : {}),
      },
      dof,
      kind,
      curve: converted,
    };
    const id = nextId('im');
    const next: ExplicitSpec = {
      ...spec,
      imposedMotions: { ...(spec.imposedMotions ?? {}), [id]: motion },
      imposedMotionOrder: [...(spec.imposedMotionOrder ?? []), id],
    };
    return changed(
      withSpec(doc, analysisCase, next),
      `add_imposed_motion: ${id} '${name}' ${kind} ${dof} of ${target.entityId}, ${curve.length} point(s) in ${caseUnit} in ${analysisId}.`,
      [analysisId, id],
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].explicit.imposedMotions (removes 1 motion)
 * @failure no controls -> EXP_CONTROLS_MISSING; unknown motion -> EXP_IMPOSED_MOTION_NOT_FOUND
 */
export const deleteImposedMotion = defineCommand({
  name: 'delete_imposed_motion',
  description: 'Remove an imposed motion (by id, affected[1] of add_imposed_motion) from an explicit_dynamics case.',
  params: z.object({ analysisId: analysisIdSchema, motionId: z.string().describe('Imposed motion id, e.g. im-12.1.') }),
  run: (doc, { analysisId, motionId }): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseExplicit(doc, 'delete_imposed_motion', code, message, [analysisId], paths);
    const found = explicitCase(doc, analysisId);
    if ('code' in found) return fail(found.code, found.message);
    const { analysisCase, spec } = found;
    if (spec === undefined) return fail('EXP_CONTROLS_MISSING', `analysis '${analysisId}' has no explicit controls yet`);
    if (spec.imposedMotions === undefined || !Object.hasOwn(spec.imposedMotions, motionId))
      return fail('EXP_IMPOSED_MOTION_NOT_FOUND', `no imposed motion '${motionId}' in '${analysisId}'`, ['motionId']);
    const imposedMotions = Object.fromEntries(Object.entries(spec.imposedMotions).filter(([id]) => id !== motionId));
    const imposedMotionOrder = (spec.imposedMotionOrder ?? []).filter((id) => id !== motionId);
    return changed(
      withSpec(doc, analysisCase, { ...spec, imposedMotions, imposedMotionOrder }),
      `delete_imposed_motion: ${motionId} removed from ${analysisId}.`,
      [analysisId],
    );
  },
});
