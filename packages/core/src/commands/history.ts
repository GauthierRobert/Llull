/**
 * Feature-history meta-commands: edit `featureHistory`, then regenerate by replaying it.
 * They carry `annotations.metaHistory` so `execute()` appends no FeatureStep for them.
 *
 * @layer core/commands
 */

import type { CadDocument, FeatureStep } from '../model/types';
import { currentContext } from './context';
import type { CommandDefinition, CommandResult } from './types';
import { defineCommand, z } from './schema';
import { kernelRefusal } from './kernelRefusal';
import { replayHistory } from './replay';
import { noop } from './noop';

/** Refuse (kernel) or replay `newHistory`; `done` receives "<n> entity|entities". */
function regenerateWith(
  doc: CadDocument,
  command: string,
  newHistory: FeatureStep[],
  done: (entityCount: string) => string,
  nextStepNumber?: number,
): CommandResult {
  const refused = kernelRefusal(doc, newHistory);
  if (refused !== null) return noop(doc, `${command}: ${refused}`);
  const replayed = replayHistory(doc, newHistory, currentContext().registry);
  const regenerated = nextStepNumber === undefined ? replayed : { ...replayed, nextStepNumber };
  const count = Object.keys(regenerated.entities).length;
  return {
    document: regenerated,
    summary: `${command}: ${done(`${count} ${count === 1 ? 'entity' : 'entities'}`)}`,
    affected: regenerated.order,
  };
}

/** Locate `stepId`, let `edit` build the new history (or a no-op message), then regenerate. */
function editStep(
  doc: CadDocument,
  command: string,
  stepId: string,
  edit: (
    idx: number,
    step: FeatureStep,
  ) => string | { history: FeatureStep[]; done: (entityCount: string) => string },
): CommandResult {
  const idx = doc.featureHistory.findIndex((s) => s.id === stepId);
  const step = doc.featureHistory[idx];
  if (!step) return noop(doc, `${command}: step '${stepId}' not found in featureHistory.`);
  const edited = edit(idx, step);
  if (typeof edited === 'string') return noop(doc, `${command}: ${edited}`);
  return regenerateWith(doc, command, edited.history, edited.done);
}

/**
 * @command replay_history
 * @pure
 * @layer core/commands
 * @affects regenerates all entities from the featureHistory list
 * @invariant featureHistory is preserved unchanged; entities are re-evaluated
 * @failure empty history -> returns doc unchanged, affected:[]
 */
const replayHistory_cmd = defineCommand({
  name: 'replay_history',
  description:
    'Recompute the document from scratch by replaying all non-suppressed steps in ' +
    'featureHistory in order. Use after manually editing the history list or to ' +
    'verify the document is consistent with its feature recipe.',
  params: z.object({}),
  annotations: { metaHistory: true, idempotent: true },
  run: (doc, _params): CommandResult => {
    if (doc.featureHistory.length === 0) {
      return noop(doc, 'replay_history: featureHistory is empty — nothing to replay.');
    }
    const warnings: string[] = [];
    const refused = kernelRefusal(doc, doc.featureHistory);
    if (refused !== null) {
      return noop(doc, `replay_history: ${refused}`);
    }
    const regenerated = replayHistory(doc, doc.featureHistory, currentContext().registry, warnings);
    const count = Object.keys(regenerated.entities).length;
    const warnSuffix =
      warnings.length > 0
        ? ` Unresolved expressions (${warnings.length}): ${warnings.join('; ')}.`
        : '';
    return {
      document: regenerated,
      summary: `replay_history: replayed ${doc.featureHistory.length} step(s); ${count} ${count === 1 ? 'entity' : 'entities'} in document.${warnSuffix}`,
      affected: regenerated.order,
    };
  },
});

/**
 * @command set_step_suppressed
 * @pure
 * @layer core/commands
 * @affects toggles suppressed flag on a FeatureStep then regenerates the document
 * @invariant featureHistory length is unchanged
 * @failure unknown stepId -> no-op, affected:[]
 */
const setStepSuppressed = defineCommand({
  name: 'set_step_suppressed',
  description:
    'Toggle the suppressed flag of a feature history step by its stepId. ' +
    'A suppressed step is skipped during replay, effectively hiding its contribution ' +
    'without deleting it. The document is regenerated after the flag is changed.',
  params: z.object({
    stepId: z
      .string()
      .describe(
        'Id of the FeatureStep to suppress or un-suppress (from doc.featureHistory[*].id).',
      ),
    suppressed: z.boolean().describe('true to suppress (skip during replay), false to restore.'),
  }),
  annotations: { metaHistory: true, idempotent: true },
  run: (doc, { stepId, suppressed }): CommandResult => {
    return editStep(doc, 'set_step_suppressed', stepId, (idx, step) => ({
      history: doc.featureHistory.map((s, i) => (i === idx ? { ...step, suppressed } : s)),
      done: (n) => `step '${stepId}' suppressed=${String(suppressed)}; regenerated ${n}.`,
    }));
  },
});

/**
 * @command edit_step_params
 * @pure
 * @layer core/commands
 * @affects replaces params of a FeatureStep then regenerates the document
 * @invariant featureHistory length is unchanged; step name is unchanged
 * @failure unknown stepId -> no-op, affected:[]
 */
const editStepParams = defineCommand({
  name: 'edit_step_params',
  description:
    'Replace the params of a feature history step by its stepId, then regenerate ' +
    'the document by replaying featureHistory. Use to parametrically edit a past ' +
    'operation (e.g. change the size of a box created earlier).',
  params: z.object({
    stepId: z
      .string()
      .describe(
        'Id of the FeatureStep whose params are to be replaced (from doc.featureHistory[*].id).',
      ),
    params: z
      .object({})
      .describe(
        'New params object for the step. Must be compatible with the command named in the step ' +
          '(i.e. a valid params object for step.name). The document is regenerated after replacement.',
      ),
  }),
  annotations: { metaHistory: true, idempotent: true },
  run: (doc, { stepId, params: newParams }): CommandResult => {
    return editStep(doc, 'edit_step_params', stepId, (idx, step) => ({
      history: doc.featureHistory.map((s, i) => (i === idx ? { ...step, params: newParams } : s)),
      done: (n) => `step '${stepId}' params updated; regenerated ${n}.`,
    }));
  },
});

/**
 * @command reorder_step
 * @pure
 * @layer core/commands
 * @affects moves a FeatureStep to a new index then regenerates the document
 * @invariant featureHistory length is unchanged
 * @failure unknown stepId -> no-op, affected:[]
 */
const reorderStep = defineCommand({
  name: 'reorder_step',
  description:
    'Move a feature history step to a new position (0-based index) in the featureHistory ' +
    'list, then regenerate the document. Use to change the order in which operations are applied.',
  params: z.object({
    stepId: z.string().describe('Id of the FeatureStep to move (from doc.featureHistory[*].id).'),
    newIndex: z
      .number()
      .describe(
        'Zero-based target index in featureHistory. Clamped to [0, history.length-1]. ' +
          'Moving to the same index is a no-op.',
      ),
  }),
  annotations: { metaHistory: true, idempotent: true },
  run: (doc, { stepId, newIndex }): CommandResult => {
    return editStep(doc, 'reorder_step', stepId, (idx, step) => {
      const clamped = Math.max(0, Math.min(newIndex, doc.featureHistory.length - 1));
      if (clamped === idx) return `step '${stepId}' is already at index ${idx}.`;
      const without = doc.featureHistory.filter((_, i) => i !== idx);
      return {
        history: [...without.slice(0, clamped), step, ...without.slice(clamped)],
        done: (n) => `step '${stepId}' moved from index ${idx} to ${clamped}; regenerated ${n}.`,
      };
    });
  },
});

/**
 * @command delete_step
 * @pure
 * @layer core/commands
 * @affects removes a FeatureStep from featureHistory then regenerates the document
 * @invariant featureHistory length decreases by 1
 * @failure unknown stepId -> no-op, affected:[]
 */
const deleteStep = defineCommand({
  name: 'delete_step',
  description:
    'Permanently remove a feature history step by its stepId from featureHistory, ' +
    'then regenerate the document. Unlike set_step_suppressed, this cannot be undone ' +
    'through the history API (use undo/redo stack instead).',
  params: z.object({
    stepId: z.string().describe('Id of the FeatureStep to delete (from doc.featureHistory[*].id).'),
  }),
  annotations: { metaHistory: true, destructive: true },
  run: (doc, { stepId }): CommandResult => {
    return editStep(doc, 'delete_step', stepId, () => ({
      history: doc.featureHistory.filter((s) => s.id !== stepId),
      done: (n) => `step '${stepId}' deleted; regenerated ${n}.`,
    }));
  },
});

/**
 * @command insert_step
 * @pure
 * @layer core/commands
 * @affects splices a new FeatureStep into featureHistory then regenerates the document
 * @invariant featureHistory length increases by 1
 * @failure afterStepId provided but not found -> no-op, affected:[]
 */
const insertStep = defineCommand({
  name: 'insert_step',
  description:
    'Splice a new feature history step into featureHistory immediately after the step ' +
    'with id afterStepId, then regenerate the document. If afterStepId is omitted the ' +
    'step is appended at the end. The new step is always active (suppressed=false).',
  params: z.object({
    afterStepId: z
      .string()
      .optional()
      .describe(
        'Id of the existing FeatureStep after which to insert the new step. ' +
          'If omitted, the new step is appended at the end of featureHistory.',
      ),
    name: z
      .string()
      .describe(
        'Registry command name (snake_case) for the new step, e.g. "add_box". ' +
          'Must be a known command name; unknown names are stored but skipped during replay.',
      ),
    params: z
      .object({})
      .describe(
        'Params object for the command named in `name`. Must be compatible with that command.',
      ),
    label: z
      .string()
      .optional()
      .describe('Optional human/AI-readable label for this step, e.g. "Base plate".'),
  }),
  annotations: { metaHistory: true, idempotent: true },
  run: (doc, { afterStepId, name: cmdName, params: stepParams, label }): CommandResult => {
    const insertIdx =
      afterStepId === undefined
        ? doc.featureHistory.length - 1
        : doc.featureHistory.findIndex((s) => s.id === afterStepId);
    if (afterStepId !== undefined && insertIdx === -1) {
      return noop(doc, `insert_step: afterStepId '${afterStepId}' not found in featureHistory.`);
    }

    const stepNumber = doc.nextStepNumber ?? 1;
    const newStep: FeatureStep = {
      id: `step-${stepNumber}`,
      name: cmdName,
      params: stepParams,
      suppressed: false,
      ...(label !== undefined ? { label } : {}),
    };
    const newHistory = [
      ...doc.featureHistory.slice(0, insertIdx + 1),
      newStep,
      ...doc.featureHistory.slice(insertIdx + 1),
    ];
    return regenerateWith(
      doc,
      'insert_step',
      newHistory,
      (n) => `step '${newStep.id}' (${cmdName}) inserted; regenerated ${n}.`,
      stepNumber + 1,
    );
  },
});

export const historyCommands: ReadonlyArray<CommandDefinition<unknown>> = [
  replayHistory_cmd,
  setStepSuppressed,
  editStepParams,
  reorderStep,
  deleteStep,
  insertStep,
] as ReadonlyArray<CommandDefinition<unknown>>;
