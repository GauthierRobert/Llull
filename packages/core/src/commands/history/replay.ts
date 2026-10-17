/**
 * Replay engine: regenerate a document from a feature-history recipe (architecture L8). Commands resolve through the active
 * `ExecutionContext.registry`.
 */

import { type CadDocument, type FeatureStep, createEmptyDocument } from '../../model/types';
import { createEmptyBuilding } from '../../model/building';
import { currentContext } from '../context';
import type { CommandDefinition, CommandError, CommandResult } from '../types';
import { commandError } from '../noop';
import { orphanState } from './carry';
import { kernelRefusal } from '../kernelRefusal';
import { nextStateKey } from './replayCache';
import { hashText } from '../../lib/hash';
import { remapIds } from './regenerate';
import { resolveStepForReplay, runReplayStep } from './replayStep';

/** One successfully replayed step, reported to `replayHistory`'s optional `onStep` observer. */
export interface ReplayStepEvent {
  readonly step: FeatureStep;
  /** Recorded params with ids remapped but `=expr` strings kept. */
  readonly rawParams: unknown;
  /** Params actually passed to the command (`=expr` resolved, ids remapped). */
  readonly params: unknown;
  readonly before: CadDocument;
  readonly after: CadDocument;
  /** The step changed nothing: it threw, was rejected, or returned the document unchanged. */
  readonly inert: boolean;
  /** Why the step failed (threw, was rejected, or a plan reported a failure); null when it succeeded. */
  readonly failure: string | null;
}

/** Why a replayed step failed, or null: a throw, a refusal (`error`) or a `build_project` report with `ok: false`. */
function failureOf(result: CommandResult | null): string | null {
  if (result === null) return 'the command threw';
  if (result.error !== undefined || result.rejected) return result.summary;
  const data = result.data;
  if (typeof data === 'object' && data !== null && (data as { ok?: unknown }).ok === false) return result.summary;
  return null;
}

/** A step that failed during a replay. */
export interface ReplayFailure {
  readonly stepId: string;
  /** Name of the command the failed step runs. */
  readonly command: string;
  readonly text: string;
}

/** Steps that record a host-produced analysis artifact: they fail when the regenerated geometry no longer matches it. */
const ANALYSIS_RECORD_COMMANDS: ReadonlySet<string> = new Set(['record_fe_mesh', 'record_fea_results']);

/** True when every failure is an analysis record step (geometry regenerated fine, the recorded analysis went stale). */
function onlyAnalysisRecords(failures: readonly ReplayFailure[]): boolean {
  return failures.length > 0 && failures.every((f) => ANALYSIS_RECORD_COMMANDS.has(f.command));
}

/** `onStep` observer helper: records `event` into `into` when its step failed. */
export function noteReplayFailure(into: ReplayFailure[], event: ReplayStepEvent): void {
  if (event.failure !== null) {
    into.push({ stepId: event.step.id, command: event.step.name, text: `${event.step.id} (${event.step.name}): ${event.failure}` });
  }
}

/** Summary suffix naming the steps whose replay failed; empty when none. */
export function replayFailuresNote(failures: readonly ReplayFailure[]): string {
  if (onlyAnalysisRecords(failures)) {
    return (
      ` Warning: the geometry was regenerated, but the analysis is now stale — ${failures.length} recorded analysis step(s) no longer match it ` +
      `(${failures.map((f) => f.text).join(' | ')}). Re-run fea_mesh then fea_solve.`
    );
  }
  return failures.length > 0
    ? ` Warning: ${failures.length} step(s) FAILED during regeneration — the model is incomplete: ${failures.map((f) => f.text).join(' | ')}`
    : '';
}

/**
 * `CommandError` for a regeneration that hid failed steps; undefined when none failed or when only analysis record steps failed (the
 * geometry is complete and the analysis is merely stale, reported in the summary).
 */
export function replayFailureError(failures: readonly ReplayFailure[]): CommandError | undefined {
  return failures.length > 0 && !onlyAnalysisRecords(failures)
    ? commandError(
        'HIST_STEP_FAILED',
        `Fix or suppress the failing step(s) (${failures.map((f) => `${f.stepId} ${f.command}`).join(', ')}) with edit_step_params / set_step_suppressed, then replay_history.${
          failures.some((f) => ANALYSIS_RECORD_COMMANDS.has(f.command))
            ? ' Failed analysis record steps mean the analysis is stale: re-run fea_mesh then fea_solve.'
            : ''
        }`,
        failures.map((f) => f.stepId),
      )
    : undefined;
}

/**
 * Replay all non-suppressed steps of `history` from a fresh document, preserving the document-level state of `base` (classification in
 * history_carry.ts). `=expr` params resolve against `base.parameters`; unresolved ones are reported in `resolveWarnings`.
 * @invariant steps with an unknown command name, or whose `run` throws, are skipped
 * @failure a live step needs the geometry kernel (`requiresKernel`) and none is available -> returns `base` unchanged (+ a warning) instead
 *   of regenerating without that step's geometry
 */
export function replayHistory(
  base: CadDocument,
  history: FeatureStep[],
  getCommandFn: (name: string) => CommandDefinition<unknown> | undefined,
  resolveWarnings?: string[],
  onStep?: (event: ReplayStepEvent) => void,
): CadDocument {
  const context = currentContext();
  const refusal = kernelRefusal(base, history, { ...context, registry: getCommandFn });
  if (refusal !== null) {
    resolveWarnings?.push(`replay refused: ${refusal}`);
    return base;
  }
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
    ...(base.nextStepNumber !== undefined ? { nextStepNumber: base.nextStepNumber } : {}),
    // Recipes must survive replay so that a recorded `instantiate_recipe` step can
    // re-expand its recipe when this history is replayed again (e.g. via replay_history).
    recipes: base.recipes,
    configurations: base.configurations,
    // Materials/components/constraints/joints/drives are regenerated by their recorded steps;
    // only entries no step produced are carried (see history_carry.ts).
    ...orphanState(base),
    // The building identity (IFC GlobalId salt) survives replay; its content is regenerated.
    ...(base.building?.uid !== undefined ? { building: { ...createEmptyBuilding(), uid: base.building.uid } } : {}),
  };
  // idMap tracks old entity id (from when the step was first recorded) → new id
  // (assigned during this replay). Subsequent steps' params are rewritten via
  // remapIds. Step-scoped ids replay identically, so this only maps legacy (pre-v2) ids.
  let idMap = new Map<string, string>();
  const cache = context.replayCache;
  // States are keyed by everything that determines them, so an unchanged prefix of an
  // edited history (or of a parameter change) is served from the cache instead of re-run.
  // Whether an artifact store is injected decides how artifact-recording steps replay (verified or flagged), so it is part of every key.
  let stateKey = cache
    ? hashText(`${context.feaArtifacts ? 'artifacts' : 'no-artifacts'}|${JSON.stringify({ ...doc, featureHistory: [] })}`)
    : '';
  for (const step of history) {
    if (step.suppressed) continue;
    const cmd = getCommandFn(step.name);
    if (!cmd) continue; // Unknown command — skip gracefully.
    const remapped = resolveStepForReplay(step, doc, idMap, resolveWarnings, 'step');
    const before = doc;
    let key = cache ? nextStateKey(stateKey, step.id, step.name, remapped) : '';
    const hit = cache?.get(key);
    let inert: boolean;
    let failure: string | null;
    if (hit !== undefined) {
      doc = { ...hit.doc, featureHistory: history };
      idMap = new Map(hit.idMap);
      inert = hit.inert;
      failure = hit.failure ?? null;
    } else {
      const uidBefore = doc.building?.uid;
      const result = runReplayStep(cmd, step, doc, remapped, idMap, context, true);
      // Accept the new geometry but keep OUR featureHistory intact.
      inert = result === null || result.document === doc;
      failure = failureOf(result);
      if (result) doc = { ...result.document, featureHistory: history };
      const mintedUid = uidBefore === undefined ? doc.building?.uid : undefined;
      if (mintedUid === undefined) cache?.set(key, { doc, idMap: new Map(idMap), inert, ...(failure !== null ? { failure } : {}) });
      else if (cache) {
        // The step minted a globally unique id (uniqueId): never memoize it, and key every later
        // state by that id so no other document is served this document's identity.
        key = nextStateKey(key, 'minted-uid', mintedUid, null);
      }
    }
    stateKey = key;
    onStep?.({ step, rawParams: remapIds(step.params, idMap), params: remapped, before, after: doc, inert, failure });
  }
  return doc;
}
