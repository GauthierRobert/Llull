/** `add_stress_restraint`, `delete_stress_restraint` (07 PST M3). */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { elementsOf, getBuilding } from '../../../building/model';
import { refuse } from '../codes';
import { RESTRAINT_KINDS, type StressRestraint } from '../model/schema';
import { edited, withModel } from '../model/store';
import { isRefusal, modelOr } from './common';

/**
 * @affects plant.stress.models[modelId].restraints: one restraint appended; the approval is dropped
 * @invariant restraints add to the mapped pipe supports; on the same degree of freedom and side the later one wins (PST_RESTRAINT_OVERRIDDEN in the analysis); directions are global axes
 * @failure unknown model -> PST_MODEL_NOT_FOUND; pipe outside the model -> PST_POINT_OFF_PIPE; unknown support -> PST_SUPPORT_NOT_FOUND; translational without axis, axis on another kind, oneWay / gap on an anchor -> PST_PARAM_INVALID
 */
export const addStressRestraint = defineCommand({
  name: 'add_stress_restraint',
  description:
    'Add a restraint to a stress model on top of the pipe supports it maps (anchor, shoe, guide, hanger). Place it with at = {supportId} (the node of an existing pipe support) or {pipeId, atMm} (arc length along the pipe centreline, mm). ' +
    'Kinds: anchor (all six degrees of freedom), rest (vertical, reacts upward only, friction on the horizontal plane), guide (horizontal lateral restraint, two-way, gap on each side; needs a pipe along a global horizontal axis or vertical), ' +
    'translational (one global axis x / y / z; oneWay "+" reacts along +axis only, "-" along -axis only, absent = two-way). gapMm is the free travel before contact (default 0); frictionCoefficient on a rest or translational restraint overrides the model friction. ' +
    'One-way, gap and friction behaviour is solved per load case (bounded iterations; PST_NONLINEAR_NOT_CONVERGED when it does not settle). Returns data { modelId, restraintId }.',
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    at: z
      .union([
        z.object({ supportId: z.string().min(1).describe('Id of a pipe support on a pipe of the model.') }),
        z.object({
          pipeId: z.string().min(1).describe('Pipe or run id in the model.'),
          atMm: z.number().min(0).describe('Arc length from the pipe start, mm.'),
        }),
      ])
      .describe('Where: {supportId} or {pipeId, atMm}.'),
    kind: z.enum(RESTRAINT_KINDS).describe('anchor | rest | guide | translational.'),
    axis: z.enum(['x', 'y', 'z']).describe('Translational only: the global axis restrained.').optional(),
    oneWay: z
      .enum(['+', '-'])
      .describe('Translational only: "+" reacts along +axis only (blocks motion toward -axis, like a rest on +z); omit for two-way.')
      .optional(),
    gapMm: z.number().min(0).describe('Free travel in mm before the restraint acts (each side of a guide). Default 0.').optional(),
    frictionCoefficient: z
      .number()
      .min(0)
      .describe(
        'Coulomb friction coefficient of a rest or translational restraint. Default: the model friction on a rest, 0 on translational.',
      )
      .optional(),
  }),
  run: (doc, params): CommandResult => {
    const model = modelOr(doc, 'add_stress_restraint', params.modelId);
    if (isRefusal(model)) return model;
    const fail = (code: string, message: string, ids: readonly string[], paths: readonly string[]): CommandResult =>
      refuse(doc, 'add_stress_restraint', code, message, ids, paths);
    if (params.kind === 'translational' && params.axis === undefined)
      return fail('PST_PARAM_INVALID', 'a translational restraint needs axis', [model.id], ['axis']);
    if (params.kind !== 'translational' && (params.axis !== undefined || params.oneWay !== undefined))
      return fail('PST_PARAM_INVALID', 'axis and oneWay apply to translational restraints only', [model.id], ['axis']);
    if (params.kind === 'anchor' && (params.gapMm !== undefined || params.frictionCoefficient !== undefined))
      return fail('PST_PARAM_INVALID', 'an anchor has no gap or friction', [model.id], ['gapMm']);
    if ('supportId' in params.at) {
      const supportId = params.at.supportId;
      const support = elementsOf(getBuilding(doc), 'pipeSupport').find((candidate) => candidate.id === supportId);
      if (support === undefined || !model.scope.ids.includes(support.pipeId))
        return fail(
          'PST_SUPPORT_NOT_FOUND',
          `no pipe support ${supportId} on the pipes of model ${model.id}`,
          [supportId],
          ['at.supportId'],
        );
    } else if (!model.scope.ids.includes(params.at.pipeId))
      return fail('PST_POINT_OFF_PIPE', `pipe ${params.at.pipeId} is not in model ${model.id}`, [params.at.pipeId], ['at.pipeId']);
    const restraint: StressRestraint = {
      id: nextId('rst'),
      at: params.at,
      kind: params.kind,
      ...(params.axis === undefined ? {} : { axis: params.axis }),
      ...(params.oneWay === undefined ? {} : { oneWay: params.oneWay }),
      ...(params.gapMm === undefined ? {} : { gapMm: params.gapMm }),
      ...(params.frictionCoefficient === undefined ? {} : { frictionCoefficient: params.frictionCoefficient }),
    };
    return {
      ...changed(
        withModel(doc, edited(model, { restraints: [...model.restraints, restraint] })),
        `add_stress_restraint: ${restraint.id} ${restraint.kind}${restraint.axis === undefined ? '' : ` ${restraint.axis}`} on model ${model.id}.`,
        [model.id, restraint.id],
      ),
      data: { modelId: model.id, restraintId: restraint.id },
    };
  },
});

/**
 * @affects plant.stress.models[modelId].restraints: the restraint removed; the approval is dropped
 * @failure unknown model -> PST_MODEL_NOT_FOUND; unknown restraint -> PST_PARAM_INVALID
 */
export const deleteStressRestraint = defineCommand({
  name: 'delete_stress_restraint',
  description:
    'Remove an extra restraint (add_stress_restraint) from a stress model. Pipe supports are removed with the support commands, not here. Returns data { modelId, restraintId }.',
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    restraintId: z.string().min(1).describe('Id of the restraint (data.restraintId of add_stress_restraint).'),
  }),
  run: (doc, { modelId, restraintId }): CommandResult => {
    const model = modelOr(doc, 'delete_stress_restraint', modelId);
    if (isRefusal(model)) return model;
    if (!model.restraints.some((restraint) => restraint.id === restraintId))
      return refuse(
        doc,
        'delete_stress_restraint',
        'PST_PARAM_INVALID',
        `model ${modelId} has no restraint ${restraintId}`,
        [restraintId],
        ['restraintId'],
      );
    return {
      ...changed(
        withModel(doc, edited(model, { restraints: model.restraints.filter((restraint) => restraint.id !== restraintId) })),
        `delete_stress_restraint: ${restraintId} removed from ${modelId}.`,
        [modelId],
      ),
      data: { modelId, restraintId },
    };
  },
});
