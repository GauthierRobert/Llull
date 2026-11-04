/** `set_stress_component`, `delete_stress_component` (07 PST M5a): the data of valves, flanges, reducers and tees the model cannot read from the pipes. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { pipeCentreline } from '../../common/pipeCentrelines';
import { refuse } from '../codes';
import { runComponents } from '../model/components';
import { COMPONENT_KINDS, TEE_FITTINGS, type StressComponent } from '../model/schema';
import { vertexArcs } from '../model/sections';
import { edited, withModel } from '../model/store';
import { isRefusal, modelOr } from './common';

const sameTarget = (a: StressComponent['target'], b: StressComponent['target']): boolean =>
  ('componentId' in a && 'componentId' in b && a.componentId === b.componentId) ||
  ('branchPipeId' in a && 'branchPipeId' in b && a.branchPipeId === b.branchPipeId);

/**
 * @affects plant.stress.models[modelId].components: one record added or its given fields replaced; the approval is dropped
 * @invariant a valve, flange or declared rigid body is rigid unless rigid is false; a reducer is elastic (mean section) unless rigid is true; a stated weightKg replaces the pipe weight of the body; a branch fitting changes the SIF of the tee only
 * @failure unknown model -> PST_MODEL_NOT_FOUND; unknown inline component -> PST_COMPONENT_NOT_FOUND; pipe outside the model or point beyond the pipe -> PST_PIPE_NOT_FOUND / PST_POINT_OFF_PIPE; field that does not apply to the target, reinforced_tee without padMm, rigid with stiffnessFactor, nothing to set -> PST_PARAM_INVALID
 */
export const setStressComponent = defineCommand({
  name: 'set_stress_component',
  description:
    'Give a pipe stress model the data of a component: weight, rigidity, tee fitting. Target exactly one of: componentId (an inline valve or reducer of an 02 RTE run in the model: affected id of insert_inline_component), ' +
    'branchPipeId (the branch pipe / run whose end meets another pipe: the tee or olet there), or declare {pipeId, atMm, lengthMm, kind valve | flange | rigid} (a body of lengthMm centred atMm along the pipe, for building pipes or for flanges an RTE run does not list; pass id to edit a declared record). ' +
    'Data: weightKg (kg, the whole body; for a valve or flange it replaces the pipe weight of its length and acts half at each end; for a tee it is a point weight at the junction), rigid (true: stiff body, no code check; default true for valve / flange / rigid, false for a reducer), ' +
    'stiffnessFactor (elastic body: multiplier of the pipe stiffness, default 1; not with rigid true), fitting (branch pipe only: welding_tee | unreinforced_tee | reinforced_tee | weldolet; default from the RTE derivation, else unreinforced_tee flagged PST_TEE_FITTING_ASSUMED), padMm (reinforced_tee: pad thickness). ' +
    'A reducer is one elastic element of the mean outside diameter and wall of its two sizes. Tees are detected from the geometry: a pipe end on the interior of another pipe (or three pipes meeting at one point) with a 90 degree branch. Returns data { modelId, componentRecordId }.',
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    componentId: z.string().min(1).describe('Id of an inline valve or reducer of an RTE run in the model.').optional(),
    branchPipeId: z.string().min(1).describe('Id of the branch pipe or run (a pipe of the model) whose end is the tee or olet.').optional(),
    declare: z
      .object({
        pipeId: z.string().min(1).describe('Pipe or run id in the model.'),
        atMm: z.number().min(0).describe('Arc length of the centre of the body from the pipe start, mm.'),
        lengthMm: z.number().positive().describe('Length of the body along the pipe, mm (at least 2).'),
        kind: z.enum(COMPONENT_KINDS).describe('valve | flange | rigid.'),
        id: z.string().min(1).describe('Id of an already declared record to replace (data.componentRecordId).').optional(),
      })
      .describe('Declare a body on a pipe.')
      .optional(),
    weightKg: z.number().min(0).describe('Weight of the whole component in kg.').optional(),
    rigid: z.boolean().describe('Rigid body (true) or elastic (false).').optional(),
    stiffnessFactor: z.number().positive().describe('Elastic body: multiplier of the pipe stiffness (default 1).').optional(),
    fitting: z.enum(TEE_FITTINGS).describe('Tee branch only: the fitting whose SIF applies.').optional(),
    padMm: z.number().positive().describe('Reinforced tee: pad or saddle thickness in mm.').optional(),
  }),
  run: (doc, params): CommandResult => {
    const model = modelOr(doc, 'set_stress_component', params.modelId);
    if (isRefusal(model)) return model;
    const fail = (code: string, message: string, ids: readonly string[], paths: readonly string[]): CommandResult =>
      refuse(doc, 'set_stress_component', code, message, ids, paths);
    const targets = [params.componentId, params.branchPipeId, params.declare].filter((entry) => entry !== undefined).length;
    if (targets !== 1)
      return fail('PST_PARAM_INVALID', 'give exactly one of componentId, branchPipeId and declare', [model.id], ['componentId']);
    const data = {
      ...(params.weightKg === undefined ? {} : { weightKg: params.weightKg }),
      ...(params.rigid === undefined ? {} : { rigid: params.rigid }),
      ...(params.stiffnessFactor === undefined ? {} : { stiffnessFactor: params.stiffnessFactor }),
      ...(params.fitting === undefined ? {} : { fitting: params.fitting }),
      ...(params.padMm === undefined ? {} : { padMm: params.padMm }),
    };
    if (Object.keys(data).length === 0)
      return fail('PST_PARAM_INVALID', 'give at least one of weightKg, rigid, stiffnessFactor, fitting, padMm', [model.id], ['weightKg']);
    if (params.rigid === true && params.stiffnessFactor !== undefined)
      return fail('PST_PARAM_INVALID', 'stiffnessFactor applies to an elastic body (rigid false)', [model.id], ['stiffnessFactor']);
    const isBranch = params.branchPipeId !== undefined;
    if (isBranch && (params.rigid !== undefined || params.stiffnessFactor !== undefined))
      return fail('PST_PARAM_INVALID', 'a tee has no rigid / stiffnessFactor (its stiffness is the pipe)', [model.id], ['rigid']);
    if (!isBranch && (params.fitting !== undefined || params.padMm !== undefined))
      return fail('PST_PARAM_INVALID', 'fitting and padMm apply to a branch pipe only', [model.id], ['fitting']);
    let target: StressComponent['target'];
    let id: string | undefined;
    if (params.componentId !== undefined) {
      const wanted = params.componentId;
      const found =
        model.scope.kind === 'runs' &&
        model.scope.ids.some((runId) => runComponents(doc, runId).components.some((entry) => entry.key === wanted));
      if (!found)
        return fail(
          'PST_COMPONENT_NOT_FOUND',
          `no inline valve or reducer ${wanted} on the runs of model ${model.id}`,
          [wanted],
          ['componentId'],
        );
      target = { componentId: wanted };
    } else if (params.branchPipeId !== undefined) {
      if (!model.scope.ids.includes(params.branchPipeId))
        return fail(
          'PST_PIPE_NOT_FOUND',
          `pipe ${params.branchPipeId} is not in model ${model.id}`,
          [params.branchPipeId],
          ['branchPipeId'],
        );
      if ((params.fitting ?? 'x') === 'reinforced_tee' && params.padMm === undefined)
        return fail('PST_PARAM_INVALID', 'a reinforced_tee needs padMm', [model.id], ['padMm']);
      target = { branchPipeId: params.branchPipeId };
    } else {
      const declared = params.declare as NonNullable<typeof params.declare>;
      if (!model.scope.ids.includes(declared.pipeId))
        return fail('PST_PIPE_NOT_FOUND', `pipe ${declared.pipeId} is not in model ${model.id}`, [declared.pipeId], ['declare.pipeId']);
      const pipe = pipeCentreline(doc, model.scope.kind, declared.pipeId);
      const total = typeof pipe === 'string' ? 0 : (vertexArcs(pipe.points).at(-1) ?? 0);
      if (typeof pipe === 'string' || declared.atMm > total || declared.lengthMm < 2)
        return fail(
          'PST_POINT_OFF_PIPE',
          `the body at ${declared.atMm} mm, ${declared.lengthMm} mm long is not on pipe ${declared.pipeId} (${total.toFixed(0)} mm long; length at least 2 mm)`,
          [declared.pipeId],
          ['declare'],
        );
      if (declared.id !== undefined && !model.components.some((entry) => entry.id === declared.id))
        return fail('PST_COMPONENT_NOT_FOUND', `model ${model.id} has no declared component ${declared.id}`, [declared.id], ['declare.id']);
      id = declared.id;
      target = { pipeId: declared.pipeId, atMm: declared.atMm, lengthMm: declared.lengthMm, kind: declared.kind };
    }
    const existing = model.components.find((entry) => (id === undefined ? sameTarget(entry.target, target) : entry.id === id));
    const record: StressComponent = { ...(existing ?? {}), id: existing?.id ?? nextId('cmp'), target, ...data };
    const components =
      existing === undefined ? [...model.components, record] : model.components.map((entry) => (entry.id === existing.id ? record : entry));
    return {
      ...changed(
        withModel(doc, edited(model, { components })),
        `set_stress_component: ${record.id} ${Object.keys(target).includes('componentId') ? 'inline' : isBranch ? 'branch' : 'declared'} ${Object.keys(data).join(', ')} on model ${model.id}.`,
        [model.id, record.id],
      ),
      data: { modelId: model.id, componentRecordId: record.id },
    };
  },
});

/**
 * @affects plant.stress.models[modelId].components: the record removed; the approval is dropped
 * @failure unknown model -> PST_MODEL_NOT_FOUND; unknown record -> PST_COMPONENT_NOT_FOUND
 */
export const deleteStressComponent = defineCommand({
  name: 'delete_stress_component',
  description:
    'Remove component data (set_stress_component) from a stress model: a declared body disappears from the model, the data of an RTE valve / reducer / tee returns to its defaults. Returns data { modelId, componentRecordId }.',
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    componentRecordId: z.string().min(1).describe('Id of the record (data.componentRecordId of set_stress_component).'),
  }),
  run: (doc, { modelId, componentRecordId }): CommandResult => {
    const model = modelOr(doc, 'delete_stress_component', modelId);
    if (isRefusal(model)) return model;
    if (!model.components.some((entry) => entry.id === componentRecordId))
      return refuse(
        doc,
        'delete_stress_component',
        'PST_COMPONENT_NOT_FOUND',
        `model ${modelId} has no component record ${componentRecordId}`,
        [componentRecordId],
        ['componentRecordId'],
      );
    return {
      ...changed(
        withModel(doc, edited(model, { components: model.components.filter((entry) => entry.id !== componentRecordId) })),
        `delete_stress_component: ${componentRecordId} removed from ${modelId}.`,
        [modelId],
      ),
      data: { modelId, componentRecordId },
    };
  },
});
