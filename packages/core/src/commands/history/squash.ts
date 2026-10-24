/**
 * squash_steps: merge consecutive feature steps into one `build_project` step (history growth of a drag-heavy session, 04 DIR D6). The merged
 * step re-runs the same commands inside ONE step, so it is accepted only when replaying the new history gives exactly the document that exists
 * now (entities, order and every other definition), which guarantees replay equality and that no step-scoped id changed.
 */

import type { CadDocument, FeatureStep } from '../../model/types';
import { canonicalJson } from '../../lib/canonicalJson';
import { isRecord } from '../../lib/isRecord';
import { currentContext } from '../context';
import { defineCommand, z } from '../schema';
import { kernelRefusal } from '../kernelRefusal';
import { changed, noop } from '../noop';
import { replayHistory } from './replay';

const COMMAND = 'squash_steps';

/** The plan actions a step contributes to the merged step (a recorded `build_project` contributes its own actions). */
function actionsOf(step: FeatureStep): unknown[] {
  if (step.name === 'build_project' && isRecord(step.params) && Array.isArray(step.params['actions'])) return step.params['actions'];
  return [{ command: step.name, params: step.params }];
}

/** The definition of `doc` without its history bookkeeping, as canonical text. */
const fingerprint = (doc: CadDocument): string => canonicalJson({ ...doc, featureHistory: [], nextStepNumber: 0 });

/**
 * @affects replaces featureHistory steps from..to by ONE `build_project` step carrying their commands; entities and every other definition are unchanged
 * @invariant replaying the new history reproduces the current document exactly (entities, order, ids); the merged step keeps the id of the first step; nextStepNumber is unchanged (step numbers are never reused)
 * @failure unknown step id, from after to, a single step, a suppressed step in the range, a failing replay, a kernel step without a kernel, or a merge that would change the document (typically it creates entities or elements whose ids come from the step number) -> no-op, history unchanged
 */
export const squashSteps = defineCommand({
  name: COMMAND,
  description:
    'Merge the consecutive feature history steps fromStepId..toStepId (inclusive) into ONE step, so a long run of small edits (dozens of cage drags, pole ' +
    'moves, nudges of one entity) becomes a single history entry that undoes, edits and replays as a unit. The merged step re-runs the same commands in the ' +
    'same order. It is refused unless replaying the new history gives exactly the current document, so squash steps that EDIT existing elements; steps that ' +
    'create entities or cage elements (add_*, extrude, loop cut...) mint ids from their step number and are refused. Suppressed steps in the range are ' +
    'refused. Returns the new step id in the summary. Next: edit_step_params on the merged step, replay_history.',
  params: z.object({
    fromStepId: z.string().describe('Id of the first step to merge (from doc.featureHistory[*].id).'),
    toStepId: z.string().describe('Id of the last step to merge; it must come after fromStepId.'),
    label: z.string().describe('Optional human-readable label for the merged step.').optional(),
  }),
  annotations: { metaHistory: true },
  run: (doc, { fromStepId, toStepId, label }, ctx) => {
    const history = doc.featureHistory;
    const [from, to] = [history.findIndex((s) => s.id === fromStepId), history.findIndex((s) => s.id === toStepId)];
    if (from < 0) return noop(doc, `${COMMAND}: step '${fromStepId}' not found in featureHistory.`);
    if (to < 0) return noop(doc, `${COMMAND}: step '${toStepId}' not found in featureHistory.`);
    if (from >= to) return noop(doc, `${COMMAND}: '${fromStepId}' must come before '${toStepId}' (a single step needs no squash).`);
    const range = history.slice(from, to + 1);
    const suppressed = range.find((step) => step.suppressed);
    if (suppressed !== undefined)
      return noop(doc, `${COMMAND}: step '${suppressed.id}' is suppressed; un-suppress or exclude it. History unchanged.`);
    const first = range[0] as FeatureStep;
    const merged: FeatureStep = {
      id: first.id,
      name: 'build_project',
      params: { actions: range.flatMap(actionsOf) },
      suppressed: false,
      affected: [...new Set(range.flatMap((step) => step.affected ?? []))],
      ...(label === undefined ? (first.label === undefined ? {} : { label: first.label }) : { label }),
    };
    const next = [...history.slice(0, from), merged, ...history.slice(to + 1)];
    const context = ctx ?? currentContext();
    const refused = kernelRefusal(doc, next, context);
    if (refused !== null) return noop(doc, `${COMMAND}: ${refused}`);
    const failures: string[] = [];
    const replayed = replayHistory(doc, next, context.registry, [], (event) => {
      if (event.failure !== null) failures.push(`${event.step.id} (${event.step.name}): ${event.failure}`);
    });
    if (failures.length > 0) return noop(doc, `${COMMAND}: replaying the merged history fails — ${failures[0]}. History unchanged.`);
    if (fingerprint(replayed) !== fingerprint(doc))
      return noop(
        doc,
        `${COMMAND}: merging '${fromStepId}'..'${toStepId}' would change the document (the replayed document differs); steps that create entities or elements mint ids from their step number. History unchanged.`,
      );
    return changed(
      { ...doc, featureHistory: next },
      `${COMMAND}: ${range.length} steps ('${fromStepId}'..'${toStepId}') merged into '${merged.id}'; ${history.length} -> ${next.length} steps, document identical on replay.`,
      [...(merged.affected ?? [])],
    );
  },
});
