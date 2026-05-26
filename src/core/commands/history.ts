/**
 * Feature history commands — named, replayable command list (architecture L8).
 *
 * These meta-commands edit the `featureHistory` list and regenerate the
 * document by replaying all non-suppressed steps from `createEmptyDocument()`.
 *
 * IMPORTANT: meta-commands must NOT themselves append a FeatureStep; they carry
 * `annotations.metaHistory: true` so `execute()` skips the append hook for them.
 *
 * Circular dependency note: history.ts needs getCommand() from registry.ts, but
 * registry.ts imports history.ts. We break the cycle with a late-bound injector:
 * `setRegistryRef()` is called once from registry.ts after it constructs its map.
 * All `run` implementations call `_getCommand` via the injected reference.
 *
 * @layer core/commands
 */

import type { CadDocument, FeatureStep } from '../model/types';
import { createEmptyDocument } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { nextId } from '../../lib/id';
import { buildParamEnv, resolveStepParams } from './regenerate';

// ---------------------------------------------------------------------------
// Late-bound registry reference (breaks circular dep)
// ---------------------------------------------------------------------------

/** Injected by registry.ts after the command map is built. */
let _getCommand: ((name: string) => CommandDefinition<unknown> | undefined) | null = null;

/**
 * Called once from registry.ts to wire up the getCommand reference.
 * Must be called before any history command `run` executes.
 */
export function setRegistryRef(
  getCommandFn: (name: string) => CommandDefinition<unknown> | undefined,
): void {
  _getCommand = getCommandFn;
}

// HistoryAnnotations / HistoryCommandDefinition are no longer needed:
// `metaHistory` is now part of CommandAnnotations in types.ts.

// ---------------------------------------------------------------------------
// Internal replay helper
// ---------------------------------------------------------------------------

/**
 * Replay all non-suppressed steps in `history` from a fresh document,
 * preserving `camera`, `units`, `displayPrecision`, `parameters`,
 * `animations`, `groups`, and `layers` from `base`.
 *
 * Steps referencing unknown command names are silently skipped (graceful
 * degradation — the command may have been renamed or removed).
 *
 * Steps whose `run` throws are silently skipped (e.g. a move referencing
 * an entity that a prior suppressed step would have created).
 *
 * Any `=expr` strings in step params are resolved against `base.parameters`
 * before each step runs. Unresolved expressions are reported in `resolveWarnings`.
 *
 * @pure — returns a new CadDocument; never mutates `base`.
 */
export function replayHistory(
  base: CadDocument,
  history: FeatureStep[],
  getCommandFn: (name: string) => CommandDefinition<unknown> | undefined,
  resolveWarnings?: string[],
): CadDocument {
  // Start from empty geometry but preserve document-level settings.
  let doc: CadDocument = {
    ...createEmptyDocument(),
    camera: base.camera,
    units: base.units,
    displayPrecision: base.displayPrecision,
    parameters: base.parameters,
    animations: base.animations,
    groups: base.groups,
    layers: base.layers,
    layerOrder: base.layerOrder,
    featureHistory: history,
  };

  for (const step of history) {
    if (step.suppressed) continue;
    const cmd = getCommandFn(step.name);
    if (!cmd) continue; // Unknown command — skip gracefully.
    try {
      // Resolve any `=expr` strings in step.params against the current
      // parameter environment before running the command (KI3: constructive→evaluated).
      const env = buildParamEnv(doc.parameters);
      const { resolved, errors } = resolveStepParams(step.params, env);
      for (const e of errors) {
        resolveWarnings?.push(
          `step '${step.name}' param '${e.path}': ${e.expression} — ${e.reason}`,
        );
      }
      const result = cmd.run(doc, resolved);
      // Accept the new geometry but keep OUR featureHistory intact.
      doc = { ...result.document, featureHistory: history };
    } catch {
      // A step that throws (e.g. referencing a now-deleted entity) is skipped.
    }
  }

  return doc;
}

/** Resolve the injected getCommand or return undefined (prevents null deref). */
function resolveGetCommand(): (name: string) => CommandDefinition<unknown> | undefined {
  return _getCommand ?? (() => undefined);
}

// ---------------------------------------------------------------------------
// replay_history
// ---------------------------------------------------------------------------

interface ReplayHistoryParams {
  _?: never;
}

/**
 * @command replay_history
 * @pure
 * @layer core/commands
 * @affects regenerates all entities from the featureHistory list
 * @invariant featureHistory is preserved unchanged; entities are re-evaluated
 * @failure empty history -> returns doc unchanged, affected:[]
 */
export const replayHistory_cmd: CommandDefinition<ReplayHistoryParams> = {
  name: 'replay_history',
  description:
    'Recompute the document from scratch by replaying all non-suppressed steps in ' +
    'featureHistory in order. Use after manually editing the history list or to ' +
    'verify the document is consistent with its feature recipe.',
  paramsSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  annotations: { metaHistory: true, idempotent: true },
  run: (doc, _params): CommandResult => {
    if (doc.featureHistory.length === 0) {
      return {
        document: doc,
        summary: 'replay_history: featureHistory is empty — nothing to replay.',
        affected: [],
      };
    }
    const warnings: string[] = [];
    const regenerated = replayHistory(doc, doc.featureHistory, resolveGetCommand(), warnings);
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
};

// ---------------------------------------------------------------------------
// set_step_suppressed
// ---------------------------------------------------------------------------

interface SetStepSuppressedParams {
  stepId: string;
  suppressed: boolean;
}

/**
 * @command set_step_suppressed
 * @pure
 * @layer core/commands
 * @affects toggles suppressed flag on a FeatureStep then regenerates the document
 * @invariant featureHistory length is unchanged
 * @failure unknown stepId -> no-op, affected:[]
 */
export const setStepSuppressed: CommandDefinition<SetStepSuppressedParams> = {
  name: 'set_step_suppressed',
  description:
    'Toggle the suppressed flag of a feature history step by its stepId. ' +
    'A suppressed step is skipped during replay, effectively hiding its contribution ' +
    'without deleting it. The document is regenerated after the flag is changed.',
  paramsSchema: {
    type: 'object',
    properties: {
      stepId: {
        type: 'string',
        description:
          'Id of the FeatureStep to suppress or un-suppress (from doc.featureHistory[*].id).',
      },
      suppressed: {
        type: 'boolean',
        description: 'true to suppress (skip during replay), false to restore.',
      },
    },
    required: ['stepId', 'suppressed'],
  },
  annotations: { metaHistory: true, idempotent: true },
  run: (doc, { stepId, suppressed }): CommandResult => {
    const idx = doc.featureHistory.findIndex((s) => s.id === stepId);
    if (idx === -1) {
      return {
        document: doc,
        summary: `set_step_suppressed: step '${stepId}' not found in featureHistory.`,
        affected: [],
      };
    }
    const updatedStep: FeatureStep = { ...doc.featureHistory[idx]!, suppressed };
    const newHistory = [
      ...doc.featureHistory.slice(0, idx),
      updatedStep,
      ...doc.featureHistory.slice(idx + 1),
    ];
    const regenerated = replayHistory(doc, newHistory, resolveGetCommand());
    const count = Object.keys(regenerated.entities).length;
    return {
      document: regenerated,
      summary: `set_step_suppressed: step '${stepId}' suppressed=${String(suppressed)}; regenerated ${count} ${count === 1 ? 'entity' : 'entities'}.`,
      affected: regenerated.order,
    };
  },
};

// ---------------------------------------------------------------------------
// edit_step_params
// ---------------------------------------------------------------------------

interface EditStepParamsParams {
  stepId: string;
  params: unknown;
}

/**
 * @command edit_step_params
 * @pure
 * @layer core/commands
 * @affects replaces params of a FeatureStep then regenerates the document
 * @invariant featureHistory length is unchanged; step name is unchanged
 * @failure unknown stepId -> no-op, affected:[]
 */
export const editStepParams: CommandDefinition<EditStepParamsParams> = {
  name: 'edit_step_params',
  description:
    'Replace the params of a feature history step by its stepId, then regenerate ' +
    'the document by replaying featureHistory. Use to parametrically edit a past ' +
    'operation (e.g. change the size of a box created earlier).',
  paramsSchema: {
    type: 'object',
    properties: {
      stepId: {
        type: 'string',
        description:
          'Id of the FeatureStep whose params are to be replaced (from doc.featureHistory[*].id).',
      },
      params: {
        type: 'object',
        description:
          'New params object for the step. Must be compatible with the command named in the step ' +
          '(i.e. a valid params object for step.name). The document is regenerated after replacement.',
        properties: {},
      },
    },
    required: ['stepId', 'params'],
  },
  annotations: { metaHistory: true, idempotent: true },
  run: (doc, { stepId, params: newParams }): CommandResult => {
    const idx = doc.featureHistory.findIndex((s) => s.id === stepId);
    if (idx === -1) {
      return {
        document: doc,
        summary: `edit_step_params: step '${stepId}' not found in featureHistory.`,
        affected: [],
      };
    }
    const updatedStep: FeatureStep = { ...doc.featureHistory[idx]!, params: newParams };
    const newHistory = [
      ...doc.featureHistory.slice(0, idx),
      updatedStep,
      ...doc.featureHistory.slice(idx + 1),
    ];
    const regenerated = replayHistory(doc, newHistory, resolveGetCommand());
    const count = Object.keys(regenerated.entities).length;
    return {
      document: regenerated,
      summary: `edit_step_params: step '${stepId}' params updated; regenerated ${count} ${count === 1 ? 'entity' : 'entities'}.`,
      affected: regenerated.order,
    };
  },
};

// ---------------------------------------------------------------------------
// reorder_step
// ---------------------------------------------------------------------------

interface ReorderStepParams {
  stepId: string;
  newIndex: number;
}

/**
 * @command reorder_step
 * @pure
 * @layer core/commands
 * @affects moves a FeatureStep to a new index then regenerates the document
 * @invariant featureHistory length is unchanged
 * @failure unknown stepId -> no-op, affected:[]
 */
export const reorderStep: CommandDefinition<ReorderStepParams> = {
  name: 'reorder_step',
  description:
    'Move a feature history step to a new position (0-based index) in the featureHistory ' +
    'list, then regenerate the document. Use to change the order in which operations are applied.',
  paramsSchema: {
    type: 'object',
    properties: {
      stepId: {
        type: 'string',
        description: 'Id of the FeatureStep to move (from doc.featureHistory[*].id).',
      },
      newIndex: {
        type: 'number',
        description:
          'Zero-based target index in featureHistory. Clamped to [0, history.length-1]. ' +
          'Moving to the same index is a no-op.',
      },
    },
    required: ['stepId', 'newIndex'],
  },
  annotations: { metaHistory: true, idempotent: true },
  run: (doc, { stepId, newIndex }): CommandResult => {
    const idx = doc.featureHistory.findIndex((s) => s.id === stepId);
    if (idx === -1) {
      return {
        document: doc,
        summary: `reorder_step: step '${stepId}' not found in featureHistory.`,
        affected: [],
      };
    }
    const clamped = Math.max(0, Math.min(newIndex, doc.featureHistory.length - 1));
    if (clamped === idx) {
      return {
        document: doc,
        summary: `reorder_step: step '${stepId}' is already at index ${idx}.`,
        affected: [],
      };
    }
    const step = doc.featureHistory[idx]!;
    const without = [...doc.featureHistory.slice(0, idx), ...doc.featureHistory.slice(idx + 1)];
    const newHistory = [...without.slice(0, clamped), step, ...without.slice(clamped)];
    const regenerated = replayHistory(doc, newHistory, resolveGetCommand());
    const count = Object.keys(regenerated.entities).length;
    return {
      document: regenerated,
      summary: `reorder_step: step '${stepId}' moved from index ${idx} to ${clamped}; regenerated ${count} ${count === 1 ? 'entity' : 'entities'}.`,
      affected: regenerated.order,
    };
  },
};

// ---------------------------------------------------------------------------
// delete_step
// ---------------------------------------------------------------------------

interface DeleteStepParams {
  stepId: string;
}

/**
 * @command delete_step
 * @pure
 * @layer core/commands
 * @affects removes a FeatureStep from featureHistory then regenerates the document
 * @invariant featureHistory length decreases by 1
 * @failure unknown stepId -> no-op, affected:[]
 */
export const deleteStep: CommandDefinition<DeleteStepParams> = {
  name: 'delete_step',
  description:
    'Permanently remove a feature history step by its stepId from featureHistory, ' +
    'then regenerate the document. Unlike set_step_suppressed, this cannot be undone ' +
    'through the history API (use undo/redo stack instead).',
  paramsSchema: {
    type: 'object',
    properties: {
      stepId: {
        type: 'string',
        description: 'Id of the FeatureStep to delete (from doc.featureHistory[*].id).',
      },
    },
    required: ['stepId'],
  },
  annotations: { metaHistory: true, destructive: true },
  run: (doc, { stepId }): CommandResult => {
    const idx = doc.featureHistory.findIndex((s) => s.id === stepId);
    if (idx === -1) {
      return {
        document: doc,
        summary: `delete_step: step '${stepId}' not found in featureHistory.`,
        affected: [],
      };
    }
    const newHistory = doc.featureHistory.filter((s) => s.id !== stepId);
    const regenerated = replayHistory(doc, newHistory, resolveGetCommand());
    const count = Object.keys(regenerated.entities).length;
    return {
      document: regenerated,
      summary: `delete_step: step '${stepId}' deleted; regenerated ${count} ${count === 1 ? 'entity' : 'entities'}.`,
      affected: regenerated.order,
    };
  },
};

// ---------------------------------------------------------------------------
// insert_step
// ---------------------------------------------------------------------------

interface InsertStepParams {
  afterStepId?: string;
  name: string;
  params: unknown;
  label?: string;
}

/**
 * @command insert_step
 * @pure
 * @layer core/commands
 * @affects splices a new FeatureStep into featureHistory then regenerates the document
 * @invariant featureHistory length increases by 1
 * @failure afterStepId provided but not found -> no-op, affected:[]
 */
export const insertStep: CommandDefinition<InsertStepParams> = {
  name: 'insert_step',
  description:
    'Splice a new feature history step into featureHistory immediately after the step ' +
    'with id afterStepId, then regenerate the document. If afterStepId is omitted the ' +
    'step is appended at the end. The new step is always active (suppressed=false).',
  paramsSchema: {
    type: 'object',
    properties: {
      afterStepId: {
        type: 'string',
        description:
          'Id of the existing FeatureStep after which to insert the new step. ' +
          'If omitted, the new step is appended at the end of featureHistory.',
      },
      name: {
        type: 'string',
        description:
          'Registry command name (snake_case) for the new step, e.g. "add_box". ' +
          'Must be a known command name; unknown names are stored but skipped during replay.',
      },
      params: {
        type: 'object',
        description:
          'Params object for the command named in `name`. Must be compatible with that command.',
        properties: {},
      },
      label: {
        type: 'string',
        description: 'Optional human/AI-readable label for this step, e.g. "Base plate".',
      },
    },
    required: ['name', 'params'],
  },
  annotations: { metaHistory: true, idempotent: true },
  run: (doc, { afterStepId, name: cmdName, params: stepParams, label }): CommandResult => {
    if (afterStepId !== undefined) {
      const exists = doc.featureHistory.some((s) => s.id === afterStepId);
      if (!exists) {
        return {
          document: doc,
          summary: `insert_step: afterStepId '${afterStepId}' not found in featureHistory.`,
          affected: [],
        };
      }
    }

    const newStep: FeatureStep = {
      id: nextId('step'),
      name: cmdName,
      params: stepParams,
      suppressed: false,
      ...(label !== undefined ? { label } : {}),
    };

    let newHistory: FeatureStep[];
    if (afterStepId === undefined) {
      newHistory = [...doc.featureHistory, newStep];
    } else {
      const insertIdx = doc.featureHistory.findIndex((s) => s.id === afterStepId);
      newHistory = [
        ...doc.featureHistory.slice(0, insertIdx + 1),
        newStep,
        ...doc.featureHistory.slice(insertIdx + 1),
      ];
    }

    const regenerated = replayHistory(doc, newHistory, resolveGetCommand());
    const count = Object.keys(regenerated.entities).length;
    return {
      document: regenerated,
      summary: `insert_step: step '${newStep.id}' (${cmdName}) inserted; regenerated ${count} ${count === 1 ? 'entity' : 'entities'}.`,
      affected: regenerated.order,
    };
  },
};

// ---------------------------------------------------------------------------
// Convenience re-export — typed as CommandDefinition<unknown> for registry.ts
// ---------------------------------------------------------------------------

export const historyCommands: ReadonlyArray<CommandDefinition<unknown>> = [
  replayHistory_cmd,
  setStepSuppressed,
  editStepParams,
  reorderStep,
  deleteStep,
  insertStep,
] as ReadonlyArray<CommandDefinition<unknown>>;
