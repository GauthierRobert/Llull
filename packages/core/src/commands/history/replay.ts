/**
 * Replay engine: regenerate a document from a feature-history recipe (architecture L8). Commands resolve through the active
 * `ExecutionContext.registry`.
 */

import { type CadDocument, type FeatureStep, createEmptyDocument } from '../../model/types';
import { withSweepLayoutOf } from '../../model/documentSettings';
import { currentContext } from '../context';
import { documentExtensions } from '../../plugins/host';
import type { CommandDefinition, CommandError, CommandResult } from '../types';
import { commandError } from '../noop';
import { orphanState, withCarriedPmi } from './carry';
import { kernelRefusal } from '../kernelRefusal';
import { nextStateKey, replayCacheFor } from './replayCache';
import { deferralCount } from '../../geometry/mesh/engine';
import { hashText } from '../../lib/hash';
import { stepKeysOf } from '../../model/mergedStepKeys';
import { remapIds } from './regenerate';
import { mergeReplaySeeds } from './replaySeeds';
import { resolveStepForReplay, runReplayStep } from './replayStep';
import { parametersFingerprint, trackParameterReads, untrackedParameters } from './replayParameters';
import { fontSeed } from '../wrap/fontStore';

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
  /** A signed act that re-applied nothing because its record is not kept (`data.notReapplied`, SIG-REPLAY): its summary; absent otherwise. */
  readonly pending?: string;
}

/** Why a replayed step failed, or null: a throw, a refusal (`error`) or a `build_project` report with `ok: false`. */
function failureOf(result: CommandResult | null): string | null {
  if (result === null) return 'the command threw';
  if (result.error !== undefined || result.rejected) return result.summary;
  const data = result.data;
  if (typeof data === 'object' && data !== null && (data as { ok?: unknown }).ok === false) return result.summary;
  return null;
}

/** `{ pending: summary }` for a signed step that re-applied nothing (`data.notReapplied: true`), else `{}`. */
function pendingOf(result: CommandResult | null): { readonly pending?: string } {
  const data = result?.data;
  return result !== null && typeof data === 'object' && data !== null && (data as { notReapplied?: unknown }).notReapplied === true
    ? { pending: result.summary }
    : {};
}

/** The `pending` field of a cached state, as an optional property. */
const cachedPending = (pending: string | undefined): { readonly pending?: string } => (pending === undefined ? {} : { pending });

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

/** Keys (`stepKeyOf`) of the steps of `history` a replay runs (not suppressed), plus the keys a squashed step merged. */
function liveStepKeys(history: readonly FeatureStep[]): ReadonlySet<string> {
  return new Set(history.filter((step) => step.suppressed !== true).flatMap(stepKeysOf));
}

const SITE_CONTEXT_COMMANDS: ReadonlySet<string> = new Set(['set_site_context', 'clear_site_context']);

const KERNEL_SETTINGS_COMMANDS: ReadonlySet<string> = new Set(['set_modeling_tolerance', 'set_mesh_storage']);

/** Empty geometry that keeps the document-level settings and input state of `base` (what no recorded step regenerates). */
function replaySeed(base: CadDocument, history: FeatureStep[]): CadDocument {
  const live = liveStepKeys(history);
  return {
    ...withSweepLayoutOf(createEmptyDocument(), base),
    camera: base.camera,
    units: base.units,
    displayPrecision: base.displayPrecision,
    parameters: untrackedParameters(base.parameters),
    animations: base.animations,
    groups: base.groups,
    layers: base.layers,
    layerOrder: base.layerOrder,
    featureHistory: history,
    ...(base.nextStepNumber !== undefined ? { nextStepNumber: base.nextStepNumber } : {}),
    ...(base.uid !== undefined ? { uid: base.uid } : {}),
    // Recipes must survive replay so that a recorded `instantiate_recipe` step can
    // re-expand its recipe when this history is replayed again (e.g. via replay_history).
    recipes: base.recipes,
    configurations: base.configurations,
    // The site context is a document setting that clear_document keeps while it resets the history: carried unless a step in `history` owns it
    // (a suppressed set / clear step still removes it: the orphan rule).
    ...(base.siteContext !== undefined && !history.some((step) => SITE_CONTEXT_COMMANDS.has(step.name))
      ? { siteContext: base.siteContext }
      : {}),
    // Same for the kernel settings (modeling tolerance, mesh storage): carried unless a set_modeling_tolerance / set_mesh_storage step owns them.
    ...(base.kernelSettings !== undefined && !history.some((step) => KERNEL_SETTINGS_COMMANDS.has(step.name))
      ? { kernelSettings: base.kernelSettings }
      : {}),
    // Review state (viewpoints, issues, walkthroughs) is written only by metaHistory commands, so no step regenerates it.
    ...(base.review !== undefined ? { review: base.review } : {}),
    // Display profiles are written only by metaHistory commands as well.
    ...(base.display !== undefined ? { display: base.display } : {}),
    // Materials/components/constraints/joints/drives are regenerated by their recorded steps;
    // only entries no step produced are carried (see history_carry.ts).
    ...orphanState(base),
    // Embedded fonts (records + bytes): add_text / import_font steps resolve them by reference with no font provider.
    ...fontSeed(base),
    // Plugin identity that survives replay while the slice content is regenerated (e.g. the building's IFC GlobalId salt).
    // Seeds are deep-merged; a leaf two plugins seed differently is reported by mergeReplaySeeds (first wins) and failed by tests/unit/contract/replaySeeds.test.ts.
    // A signed record whose recording step is suppressed or deleted in `history` is not seeded (SIG-REPLAY).
    ...mergeReplaySeeds(documentExtensions().map((extension) => extension.replaySeed?.(base, live) ?? {})).seed,
  };
}

/** Input state (L8: only metaHistory commands write the parameter table, configurations, recipes, review and display) survives every recorded step. */
function restoreInputState(doc: CadDocument, before: CadDocument): CadDocument {
  if (
    doc.parameters === before.parameters &&
    doc.configurations === before.configurations &&
    doc.recipes === before.recipes &&
    doc.review === before.review &&
    doc.display === before.display
  )
    return doc;
  let restored: CadDocument = { ...doc, parameters: before.parameters, configurations: before.configurations, recipes: before.recipes };
  if (before.review !== undefined) restored = { ...restored, review: before.review };
  else delete restored.review;
  if (before.display !== undefined) restored = { ...restored, display: before.display };
  else delete restored.display;
  return restored;
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
  const seed = replaySeed(base, history);
  let doc: CadDocument = seed;
  // idMap tracks old entity id (from when the step was first recorded) → new id
  // (assigned during this replay). Subsequent steps' params are rewritten via
  // remapIds. Step-scoped ids replay identically, so this only maps legacy (pre-v2) ids.
  let idMap = new Map<string, string>();
  const cache = replayCacheFor(
    context.replayCache,
    history.reduce((live, step) => live + (step.suppressed ? 0 : 1), 0),
    base.order.length,
  );
  // States are keyed by everything that determines them, so an unchanged prefix of an
  // edited history (or of a parameter change) is served from the cache instead of re-run.
  // Whether an artifact store is injected decides how artifact-recording steps replay (verified or flagged), so it is part of every key.
  // The parameter table is NOT part of the initial key: a step depends on it only through its resolved params (already in its key) or, when
  // its `run` reads the table, through a fingerprint recorded on its cache entry and folded into every later key.
  let stateKey = cache
    ? hashText(`${context.feaArtifacts ? 'artifacts' : 'no-artifacts'}|${JSON.stringify({ ...doc, parameters: {}, featureHistory: [] })}`)
    : '';
  // From the first deferred answer on, the states are placeholders (a native job is still running): none is memoized.
  const deferralsAtStart = deferralCount();
  for (const step of history) {
    if (step.suppressed) continue;
    const cmd = getCommandFn(step.name);
    if (!cmd) continue; // Unknown command — skip gracefully.
    const remapped = resolveStepForReplay(step, doc, idMap, resolveWarnings, 'step');
    const before = doc;
    let key = cache ? nextStateKey(stateKey, step.id, step.name, remapped) : '';
    const inputFingerprint = cache ? parametersFingerprint(doc.parameters) : '';
    // A parameter-dependent state is also stored per input table, so switching tables (configurations) back and forth keeps both cached.
    const variantKey = cache ? nextStateKey(key, 'parameters-in', inputFingerprint, null) : '';
    const latest = cache?.get(key);
    const hit =
      latest?.parameterFingerprint !== undefined && latest.parameterFingerprint !== inputFingerprint ? cache?.get(variantKey) : latest;
    let parameterFingerprint: string | undefined;
    let inert: boolean;
    let failure: string | null;
    let pending: { readonly pending?: string };
    if (hit !== undefined && (hit.parameterFingerprint === undefined || hit.parameterFingerprint === inputFingerprint)) {
      doc = { ...hit.doc, ...(hit.parameterFingerprint === undefined ? { parameters: doc.parameters } : {}), featureHistory: history };
      idMap = new Map(hit.idMap);
      inert = hit.inert;
      failure = hit.failure ?? null;
      pending = cachedPending(hit.pending);
      parameterFingerprint = hit.parameterFingerprint;
    } else {
      const tracking = cache ? trackParameterReads(doc) : null;
      const runDoc = tracking?.doc ?? doc;
      const result = runReplayStep(cmd, step, runDoc, remapped, idMap, context, true, true);
      // Accept the new geometry but keep OUR featureHistory intact.
      inert = result === null || result.document === runDoc;
      failure = failureOf(result);
      pending = pendingOf(result);
      if (tracking && cache) parameterFingerprint = tracking.wasRead(result ? result.document : doc) ? inputFingerprint : undefined;
      if (result) doc = { ...(tracking ? tracking.restore(result.document) : result.document), featureHistory: history };
      // Input state (L8: only metaHistory commands write the parameter table, configurations and recipes) survives every recorded step,
      // so a replayed clear_document cannot erase what was defined after it.
      doc = restoreInputState(doc, before);
      const deferred = deferralCount() !== deferralsAtStart;
      if (!deferred) {
        const state = {
          doc,
          idMap: new Map(idMap),
          inert,
          ...(failure !== null ? { failure } : {}),
          ...pending,
          ...(parameterFingerprint !== undefined ? { parameterFingerprint } : {}),
        };
        cache?.set(key, state);
        if (parameterFingerprint !== undefined) cache?.set(variantKey, state);
      } else if (cache) {
        // An engine deferred this step or an earlier one (its result is still being computed): the state is a placeholder the host discards and re-runs. Never memoize it, and key every later state apart from the real one.
        key = nextStateKey(key, 'deferred', String(deferralCount()), null);
      }
    }
    stateKey = parameterFingerprint !== undefined ? nextStateKey(key, 'parameters', parameterFingerprint, null) : key;
    onStep?.({ step, rawParams: remapIds(step.params, idMap), params: remapped, before, after: doc, inert, failure, ...pending });
  }
  // Slices an installed plugin owns as document input state (the PLM record, ...) are re-attached AFTER the steps: carried through them, a release
  // lock would see every regenerated step as an edit of the locked definition.
  return documentExtensions().reduce((next, extension) => extension.carry?.(base, next) ?? next, withCarriedPmi(doc, base));
}
