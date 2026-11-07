/** The `plant.stress` slice of the document (07 PST): validation on load, approval carried through replay, stale-record warnings. */

import type { DocumentExtension } from '@core/plugins/plugin';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { currentInputHash } from '../analysis';
import { stressSliceSchema } from './schema';
import { getStress, withStress } from './store';

const HASH = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Errors of a raw `plant.stress` value (empty when valid). */
export function stressErrors(raw: unknown): string[] {
  const parsed = stressSliceSchema.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((issue) => `plant.stress.${issue.path.join('.')}: ${issue.message}`);
  const { models, modelOrder } = parsed.data;
  const ids = Object.keys(models);
  const approvalErrors = ids.flatMap((id) => {
    const model = models[id];
    const approval = model?.approval;
    if (approval === undefined) return [];
    const path = `plant.stress.models.${id}.approval`;
    return [
      ...(model?.recorded === undefined ? [`${path} needs recorded results`] : []),
      ...(model?.recorded !== undefined &&
      (approval.inputHash !== model.recorded.inputHash || approval.resultHash !== model.recorded.resultHash)
        ? [`${path} hashes must equal the recorded results`]
        : []),
      ...(HASH.test(approval.inputHash) && HASH.test(approval.resultHash) ? [] : [`${path} hashes must be sha256 hex`]),
      ...(ISO_UTC.test(approval.at) ? [] : [`${path}.at must be ISO-8601 UTC`]),
    ];
  });
  return [
    ...approvalErrors,
    ...(modelOrder.length === ids.length && ids.every((id) => modelOrder.includes(id))
      ? []
      : ['plant.stress.modelOrder must list every model id once']),
    ...ids.flatMap((id) => {
      const model = models[id];
      if (model === undefined) return [];
      const duplicates = (label: string, names: readonly string[]): string[] =>
        names.filter((name, index) => names.indexOf(name) !== index).map((name) => `plant.stress.models.${id}.${label}: duplicate ${name}`);
      return [
        ...duplicates(
          'wind',
          model.wind.map((entry) => entry.name),
        ),
        ...duplicates(
          'seismic',
          model.seismic.map((entry) => entry.name),
        ),
        ...duplicates(
          'springTables',
          model.springTables.map((entry) => entry.id),
        ),
        ...duplicates(
          'springs',
          model.springs.map((entry) => entry.id),
        ),
        ...model.springs.flatMap((spring, index) => {
          if (spring.kind !== 'variable') return [];
          const path = `plant.stress.models.${id}.springs.${index}`;
          return [
            ...(spring.tableId === undefined || spring.size === undefined || spring.series === undefined
              ? [`${path}: a variable spring needs tableId, size and series`]
              : []),
            ...(spring.tableId !== undefined && !model.springTables.some((table) => table.id === spring.tableId)
              ? [`${path}.tableId: no spring table ${spring.tableId}`]
              : []),
          ];
        }),
      ];
    }),
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
  // recorded results are bit-identical (same result hash) and still describe the replayed design (the current input hash equals the recorded one), and to nothing else.
  // It re-attaches even when the approve step is gone from the history: the approval is held by the previous document, not by the step.
  carry: (prev: CadDocument, next: CadDocument): CadDocument => {
    const before = getStress(prev).models;
    const after = getStress(next);
    let slice = after;
    for (const id of after.modelOrder) {
      const model = after.models[id];
      const old = Object.hasOwn(before, id) ? before[id] : undefined;
      if (model === undefined || model.approval !== undefined || old?.approval === undefined || model.recorded === undefined) continue;
      if (
        old.approval.resultHash === model.recorded.resultHash &&
        old.approval.inputHash === model.recorded.inputHash &&
        currentInputHash(next, model) === model.recorded.inputHash
      )
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
