/** The `plant.stress` slice of the document (07 PST): validation on load, approval carried through replay, stale-record warnings. */

import type { DocumentExtension } from '@core/plugins/plugin';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { currentInputHash } from '../analysis';
import { stressSliceSchema } from './schema';
import { getStress, withStress } from './store';

/** Errors of a raw `plant.stress` value (empty when valid). */
export function stressErrors(raw: unknown): string[] {
  const parsed = stressSliceSchema.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((issue) => `plant.stress.${issue.path.join('.')}: ${issue.message}`);
  const { models, modelOrder } = parsed.data;
  const ids = Object.keys(models);
  return [
    ...(modelOrder.length === ids.length && ids.every((id) => modelOrder.includes(id))
      ? []
      : ['plant.stress.modelOrder must list every model id once']),
    ...ids.filter((id) => models[id]?.id !== id).map((id) => `plant.stress.models.${id}.id must equal its key`),
  ];
}

export const pipeStressDocument: DocumentExtension = {
  validate: (raw) => {
    const plant = raw['plant'];
    return isRecord(plant) && plant['stress'] !== undefined ? stressErrors(plant['stress']) : [];
  },
  derivedEntityIds: () => new Set<string>(),
  restore: (raw) => raw,
  // An approval is a human act the replayed steps cannot redo (the signature is never recorded): after a replay it is re-attached to a model whose
  // recorded results are bit-identical (same result hash), and to nothing else.
  carry: (prev: CadDocument, next: CadDocument): CadDocument => {
    const before = getStress(prev).models;
    const after = getStress(next);
    let slice = after;
    for (const id of after.modelOrder) {
      const model = after.models[id];
      const old = Object.hasOwn(before, id) ? before[id] : undefined;
      if (model === undefined || model.approval !== undefined || old?.approval === undefined || model.recorded === undefined) continue;
      if (old.approval.resultHash === model.recorded.resultHash && old.approval.inputHash === model.recorded.inputHash)
        slice = { ...slice, models: { ...slice.models, [id]: { ...model, approval: old.approval } } };
    }
    return slice === after ? next : withStress(next, slice);
  },
  afterLoad: (doc) =>
    getStress(doc).modelOrder.flatMap((id) => {
      const model = getStress(doc).models[id];
      return model?.recorded !== undefined && currentInputHash(doc, model) !== model.recorded.inputHash
        ? [
            `pipe stress model ${id}: the recorded results are stale (inputs changed since the record)${model.approval === undefined ? '' : ' and its approval no longer covers the design'} (PST_RESULTS_STALE)`,
          ]
        : [];
    }),
};
