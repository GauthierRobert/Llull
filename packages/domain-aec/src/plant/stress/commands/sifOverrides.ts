/** `set_sif_override`, `delete_sif_override` (07 PST M5a part 2): user stress intensification / flexibility factors at a node, with the source note. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { elementsOf, getBuilding } from '../../../building/model';
import { refuse } from '../codes';
import type { SifOverride } from '../model/schema';
import { edited, withModel } from '../model/store';
import { isRefusal, modelOr } from './common';

/**
 * @affects plant.stress.models[modelId].sifOverrides: one override added, or the one at the same place replaced; the approval is dropped
 * @invariant at a bend the factors and flexibility apply to the whole bend; at a tee or another node they replace the code SIFs at the element ends of that node (equal in-plane and out-of-plane factors where no plane is known); every override is listed in the analysis (PST_SIF_OVERRIDE) with its source note
 * @failure unknown model -> PST_MODEL_NOT_FOUND; pipe or support outside the model -> PST_POINT_OFF_PIPE / PST_SUPPORT_NOT_FOUND; flexibility at a node that is not on a bend -> PST_PARAM_INVALID at analysis
 */
export const setSifOverride = defineCommand({
  name: 'set_sif_override',
  description:
    'Replace the code stress intensification factors (SIF) and the flexibility factor at a node of a pipe stress model with values the engineer states, e.g. an ASME B31J result, a manufacturer or finite-element value, or the factor of a reducer. ' +
    'Place it with at = {supportId} or {pipeId, atMm} (arc length along the pipe centreline, mm): the node nearest that point. At a bend the in-plane / out-of-plane factors and the optional flexibility factor k replace the bend values for the whole bend; at a tee or any other node the factors replace the code SIF at the element ends of that node (a tee keeps its plane; elsewhere give equal factors, otherwise the larger acts in both planes and PST_SIF_PLANE_UNKNOWN is raised). ' +
    'sifInPlane and sifOutOfPlane are the i_i and i_o of ASME B31.3 App. D / B31J (both >= 1; B31.1 uses one value, give it twice); flexibility is k >= 1 (bends only). `source` is required (the document or calculation the value comes from) and is listed in every analysis as PST_SIF_OVERRIDE; the stress result stays a review item. ' +
    'A second override at the same place replaces the first. Returns data { modelId, overrideId }.',
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
    sifInPlane: z.number().min(1).describe('In-plane stress intensification factor i_i (>= 1).'),
    sifOutOfPlane: z.number().min(1).describe('Out-of-plane stress intensification factor i_o (>= 1).'),
    flexibility: z.number().min(1).describe('Flexibility factor k (>= 1), bends only. Default: the code value.').optional(),
    source: z.string().min(3).describe('Where the values come from (standard and table, manufacturer data sheet, calculation id).'),
  }),
  run: (doc, params): CommandResult => {
    const model = modelOr(doc, 'set_sif_override', params.modelId);
    if (isRefusal(model)) return model;
    const fail = (code: string, message: string, ids: readonly string[], paths: readonly string[]): CommandResult =>
      refuse(doc, 'set_sif_override', code, message, ids, paths);
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
    const same = (a: SifOverride['at'], b: SifOverride['at']): boolean =>
      'supportId' in a
        ? 'supportId' in b && a.supportId === b.supportId
        : 'pipeId' in b && a.pipeId === b.pipeId && Math.abs(a.atMm - b.atMm) < 1;
    const existing = model.sifOverrides.find((entry) => same(entry.at, params.at));
    const record: SifOverride = {
      id: existing?.id ?? nextId('sif'),
      at: params.at,
      sifInPlane: params.sifInPlane,
      sifOutOfPlane: params.sifOutOfPlane,
      ...(params.flexibility === undefined ? {} : { flexibility: params.flexibility }),
      source: params.source,
    };
    const sifOverrides =
      existing === undefined
        ? [...model.sifOverrides, record]
        : model.sifOverrides.map((entry) => (entry.id === existing.id ? record : entry));
    return {
      ...changed(
        withModel(doc, edited(model, { sifOverrides })),
        `set_sif_override: ${record.id} ii ${record.sifInPlane} io ${record.sifOutOfPlane}${record.flexibility === undefined ? '' : ` k ${record.flexibility}`} on model ${model.id} (source: ${record.source}).`,
        [model.id, record.id],
      ),
      data: { modelId: model.id, overrideId: record.id },
    };
  },
});

/**
 * @affects plant.stress.models[modelId].sifOverrides: the override removed (the code SIF applies again); the approval is dropped
 * @failure unknown model -> PST_MODEL_NOT_FOUND; unknown override -> PST_SIF_NOT_FOUND
 */
export const deleteSifOverride = defineCommand({
  name: 'delete_sif_override',
  description:
    'Remove a user SIF override (set_sif_override) from a stress model: the code value applies again at that node. Returns data { modelId, overrideId }.',
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    overrideId: z.string().min(1).describe('Id of the override (data.overrideId of set_sif_override).'),
  }),
  run: (doc, { modelId, overrideId }): CommandResult => {
    const model = modelOr(doc, 'delete_sif_override', modelId);
    if (isRefusal(model)) return model;
    if (!model.sifOverrides.some((entry) => entry.id === overrideId))
      return refuse(
        doc,
        'delete_sif_override',
        'PST_SIF_NOT_FOUND',
        `model ${modelId} has no SIF override ${overrideId}`,
        [overrideId],
        ['overrideId'],
      );
    return {
      ...changed(
        withModel(doc, edited(model, { sifOverrides: model.sifOverrides.filter((entry) => entry.id !== overrideId) })),
        `delete_sif_override: ${overrideId} removed from ${modelId}.`,
        [modelId],
      ),
      data: { modelId, overrideId },
    };
  },
});
