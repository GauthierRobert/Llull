/** `create_stress_model`, `update_stress_model`, `delete_stress_model` (07 PST M3). */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { nextId } from '@lib/id';
import { getBuilding } from '../../../building/model';
import { getPiping } from '../../piping/model';
import { RULE_SET_IDS } from '../code/ruleSets';
import { refuse } from '../codes';
import type { StressModel } from '../model/schema';
import { runsOfLine } from '../model/sources';
import { edited, getStress, withModel, withStress } from '../model/store';
import { isRefusal, modelOr } from './common';

const DEFAULT_MAX_ELEMENT_MM = 3000;
const DEFAULT_ELBOW_FACTOR = 1.5;
const DEFAULT_FRICTION = 0.3;

const pipeIdsParam = z
  .array(z.string().min(1))
  .min(1)
  .describe(
    'Ids of the pipes to analyse: building pipes (add_pipe_run) or 02 RTE runs (route_pipe), not mixed. Pipes whose ends meet within 1 mm form one system.',
  );

type Scope = StressModel['scope'];

/** The scope of `ids` (all building pipes or all runs), or the refusal. */
function scopeOf(doc: CadDocument, command: string, ids: readonly string[]): Scope | CommandResult {
  const unique = [...new Set(ids)];
  const building = getBuilding(doc);
  const runs = getPiping(doc).runs;
  const kinds = unique.map((id) =>
    Object.hasOwn(building.elements, id) && building.elements[id]?.category === 'pipe' ? 'pipes' : Object.hasOwn(runs, id) ? 'runs' : null,
  );
  const unknown = unique.filter((_, index) => kinds[index] === null);
  if (unknown.length > 0)
    return refuse(doc, command, 'PST_PIPE_NOT_FOUND', `no pipe or run with id ${unknown.join(', ')}`, unknown, ['pipeIds']);
  const first = kinds[0] as 'pipes' | 'runs';
  if (kinds.some((kind) => kind !== first))
    return refuse(
      doc,
      command,
      'PST_PARAM_INVALID',
      'building pipes and plant runs cannot be mixed in one model: make one model each',
      unique,
      ['pipeIds'],
    );
  return { kind: first, ids: unique };
}

const isScope = (value: Scope | CommandResult): value is Scope => 'ids' in value;

/**
 * @affects plant.stress.models[modelId]: the new model, no operating conditions or load cases yet
 * @invariant stores references and rules, never geometry: the finite element model is rebuilt from the current pipes on every analysis; ids step-scoped (stress-<step>.<k>); named defaults are listed in model.defaulted
 * @failure neither or both of pipeIds / lineId, document not in mm -> PST_PARAM_INVALID; unknown pipe / run -> PST_PIPE_NOT_FOUND; line without runs -> PST_NO_PIPES
 */
export const createStressModel = defineCommand({
  name: 'create_stress_model',
  description:
    'Create a pipe stress model (07 PST) of a piping system: a reference to its pipes and the code rules, not a copy of the geometry (the model is rebuilt from the current pipes on every analysis). ' +
    'Scope: pipeIds (building pipes from add_pipe_run, or 02 RTE run ids from route_pipe) or lineId (all runs of a plant pipeline). Units: mm, N, MPa, degC, bar g; Z is up; the document must be in mm. ' +
    '`rule` names the code and edition (B31.3-2016 .. 2024, B31.1-2016 .. 2022); there is no default edition. Named defaults, listed in the result and in every analysis: maxElementLengthMm 3000, elbowRadiusFactor 1.5 (long radius bends of R = 1.5 x nominal size at corners that carry no RTE bend radius; 0 keeps sharp corners with k = 1 and i = 1), frictionCoefficient 0.3 (steel on steel). ' +
    'Next: set_pipe_operating_conditions, set_stress_load_cases (preset b31.3-default), pipe supports (add_pipe_support: anchor, shoe, guide, hanger map to restraints) or add_stress_restraint, then analyze_pipe_stress and check_pipe_stress. ' +
    'Run bends come from the RTE derivation; a pipe end on another pipe is a tee with its code SIF, RTE valves are rigid bodies and reducers elastic elements (weights and fittings: set_stress_component). Returns data { modelId, scope, rule, defaulted }.',
  params: z.object({
    name: z.string().min(1).describe('Model name, e.g. "P-101 hot line".'),
    pipeIds: pipeIdsParam.optional(),
    lineId: z
      .string()
      .min(1)
      .describe('Alternative to pipeIds: the id of a plant pipeline (create_pipeline); all its runs are analysed.')
      .optional(),
    rule: z
      .enum(RULE_SET_IDS)
      .describe(
        'Code and edition: B31.3-2016, B31.3-2018, B31.3-2020, B31.3-2022, B31.3-2024, B31.1-2016, B31.1-2018, B31.1-2020, B31.1-2022. Required; no default.',
      ),
    maxElementLengthMm: z.number().positive().describe('Longest straight element in mm. Default 3000.').optional(),
    elbowRadiusFactor: z
      .number()
      .min(0)
      .describe(
        'Bend radius R1 / nominal size for corners without an RTE bend radius. Default 1.5 (long radius); 0 keeps sharp corners (k = 1, i = 1).',
      )
      .optional(),
    frictionCoefficient: z
      .number()
      .min(0)
      .describe('Coulomb friction of shoes and rests on their supports. Default 0.3 (steel on steel); 0.1 for PTFE.')
      .optional(),
  }),
  run: (doc, params): CommandResult => {
    if ((params.pipeIds === undefined) === (params.lineId === undefined))
      return refuse(doc, 'create_stress_model', 'PST_PARAM_INVALID', 'give exactly one of pipeIds and lineId', [], ['pipeIds']);
    if (doc.units !== 'mm')
      return refuse(
        doc,
        'create_stress_model',
        'PST_PARAM_INVALID',
        `plant lengths are mm; this document is in ${doc.units}`,
        [],
        ['units'],
      );
    let ids: readonly string[];
    if (params.lineId !== undefined) {
      if (!Object.hasOwn(getPiping(doc).lines, params.lineId))
        return refuse(doc, 'create_stress_model', 'PST_NO_PIPES', `no pipeline "${params.lineId}"`, [params.lineId], ['lineId']);
      ids = runsOfLine(doc, params.lineId);
      if (ids.length === 0)
        return refuse(doc, 'create_stress_model', 'PST_NO_PIPES', `pipeline ${params.lineId} has no runs`, [params.lineId], ['lineId']);
    } else ids = params.pipeIds ?? [];
    const scope = scopeOf(doc, 'create_stress_model', ids);
    if (!isScope(scope)) return scope;
    const defaulted = [
      ...(params.maxElementLengthMm === undefined ? ['maxElementLengthMm'] : []),
      ...(params.elbowRadiusFactor === undefined ? ['elbowRadiusFactor'] : []),
      ...(params.frictionCoefficient === undefined ? ['frictionCoefficient'] : []),
    ];
    const model: StressModel = {
      id: nextId('stress'),
      name: params.name,
      scope,
      rule: params.rule,
      maxElementLengthMm: params.maxElementLengthMm ?? DEFAULT_MAX_ELEMENT_MM,
      elbowRadiusFactor: params.elbowRadiusFactor ?? DEFAULT_ELBOW_FACTOR,
      frictionCoefficient: params.frictionCoefficient ?? DEFAULT_FRICTION,
      defaulted,
      loadCases: [],
      forces: [],
      restraints: [],
      displacements: [],
      sifOverrides: [],
      components: [],
    };
    return {
      ...changed(
        withModel(doc, model),
        `create_stress_model: ${model.id} "${model.name}" on ${scope.ids.length} ${scope.kind === 'runs' ? 'run' : 'pipe'}(s), ${model.rule}${defaulted.length > 0 ? `; defaulted ${defaulted.join(', ')}` : ''}.`,
        [model.id],
      ),
      data: { modelId: model.id, scope, rule: model.rule, defaulted },
    };
  },
});

/**
 * @affects plant.stress.models[modelId]: the named fields replaced; the approval is dropped (recorded results stay and turn stale by hash)
 * @invariant conditions, load cases and restraints are kept; defaulted names of fields now given are removed
 * @failure unknown model -> PST_MODEL_NOT_FOUND; unknown pipe -> PST_PIPE_NOT_FOUND; nothing to change -> PST_PARAM_INVALID
 */
export const updateStressModel = defineCommand({
  name: 'update_stress_model',
  description:
    'Edit a stress model: name, pipe scope, code edition, element length, elbow radius factor or friction. Only the given fields change; conditions, load cases and restraints stay. ' +
    'An approval is dropped (it covered fixed results) and recorded results turn stale until record_pipe_stress_results is run again. Returns data { modelId, changed }.',
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model (create_stress_model).'),
    name: z.string().min(1).describe('New name.').optional(),
    pipeIds: pipeIdsParam.describe('New scope: replaces the pipes / runs of the model.').optional(),
    rule: z.enum(RULE_SET_IDS).describe('New code and edition.').optional(),
    maxElementLengthMm: z.number().positive().describe('Longest straight element in mm.').optional(),
    elbowRadiusFactor: z
      .number()
      .min(0)
      .describe('Bend radius R1 / nominal size for corners without an RTE bend radius (0 = sharp).')
      .optional(),
    frictionCoefficient: z.number().min(0).describe('Coulomb friction of shoes and rests.').optional(),
  }),
  run: (doc, params): CommandResult => {
    const model = modelOr(doc, 'update_stress_model', params.modelId);
    if (isRefusal(model)) return model;
    const patch: Partial<StressModel> = {};
    const names: string[] = [];
    const set = <K extends keyof StressModel>(key: K, value: StressModel[K] | undefined): void => {
      if (value === undefined) return;
      patch[key] = value;
      names.push(key);
    };
    set('name', params.name);
    set('rule', params.rule);
    set('maxElementLengthMm', params.maxElementLengthMm);
    set('elbowRadiusFactor', params.elbowRadiusFactor);
    set('frictionCoefficient', params.frictionCoefficient);
    if (params.pipeIds !== undefined) {
      const scope = scopeOf(doc, 'update_stress_model', params.pipeIds);
      if (!isScope(scope)) return scope;
      set('scope', scope);
    }
    if (names.length === 0)
      return refuse(doc, 'update_stress_model', 'PST_PARAM_INVALID', 'give at least one field to change', [model.id], ['name']);
    patch.defaulted = model.defaulted.filter((entry) => !names.includes(entry));
    return {
      ...changed(
        withModel(doc, edited(model, patch)),
        `update_stress_model: ${model.id} changed ${names.join(', ')}${model.approval === undefined ? '' : '; approval dropped'}.`,
        [model.id],
      ),
      data: { modelId: model.id, changed: names, approvalDropped: model.approval !== undefined },
    };
  },
});

/**
 * @affects plant.stress.models[modelId]: removed with its recorded results and approval
 * @failure unknown model -> PST_MODEL_NOT_FOUND
 */
export const deleteStressModel = defineCommand({
  name: 'delete_stress_model',
  description:
    'Delete a stress model with its conditions, load cases, restraints, recorded results and approval. Returns data { modelId }.',
  params: z.object({ modelId: z.string().min(1).describe('Id of the stress model.') }),
  run: (doc, { modelId }): CommandResult => {
    const model = modelOr(doc, 'delete_stress_model', modelId);
    if (isRefusal(model)) return model;
    const stress = getStress(doc);
    const { [modelId]: removed, ...rest } = stress.models;
    void removed;
    return {
      ...changed(
        withStress(doc, { models: rest, modelOrder: stress.modelOrder.filter((id) => id !== modelId) }),
        `delete_stress_model: ${modelId} removed${model.approval === undefined ? '' : ' (its approval is gone with it)'}.`,
        [modelId],
      ),
      data: { modelId },
    };
  },
});
