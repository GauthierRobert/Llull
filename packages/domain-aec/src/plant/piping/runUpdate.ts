/**
 * Committing a change to stored runs (02 RTE M2): store the changed runs, derive them and every run attached to them (branches, continuations)
 * and rebuild their display entities, or report the first run that no longer derives so the command can refuse with the document unchanged.
 * @invariant atomic: either every affected run derives and the entities are rebuilt, or nothing is returned but the failure
 */

import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import type { PipeRun } from '@aec/plant/types';
import type { DerivationFailure, RunDerivation } from './deriveTypes';
import { withRunEntities } from './derive';
import { getPiping, refuse, withPiping } from './model';
import { deriveRun } from './routeParts';
import { withDependents } from './runLinks';

export type RunFailure = DerivationFailure & { readonly runId: string };

export interface Rederived {
  readonly ok: true;
  readonly document: CadDocument;
  /** The derivation of every run that was re-derived (the given ones and their dependents), by run id. */
  readonly derivations: Readonly<Record<string, RunDerivation>>;
  /** Ids of the re-derived runs, in run order. */
  readonly runIds: readonly string[];
}

/** `doc` with `runs` stored (replaced by id; new ids are appended to the run order, `removed` ids dropped from it). */
export function withRuns(doc: CadDocument, runs: readonly PipeRun[]): CadDocument {
  const piping = getPiping(doc);
  const stored = { ...piping.runs };
  const order = [...piping.runOrder];
  for (const run of runs) {
    stored[run.id] = run;
    if (!order.includes(run.id)) order.push(run.id);
  }
  return withPiping(doc, { ...piping, runs: stored, runOrder: order });
}

/**
 * Derives `runIds` and the runs attached to them in `doc`, then rebuilds their entities.
 * @failure any of them does not derive -> that run's failure with `runId` (the caller refuses; `doc` is not touched)
 */
export function rederive(doc: CadDocument, runIds: readonly string[]): Rederived | RunFailure {
  const piping = getPiping(doc);
  const wanted = new Set(runIds.flatMap((id) => withDependents(piping, id)));
  const ordered = piping.runOrder.filter((id) => wanted.has(id));
  const derivations: Record<string, RunDerivation> = {};
  for (const id of ordered) {
    const derived = deriveRun(doc, piping.runs[id] as PipeRun);
    if (!derived.ok) return { ...derived, runId: id };
    derivations[id] = derived;
  }
  return { ok: true, document: ordered.reduce(withRunEntities, doc), derivations, runIds: ordered };
}

/** The refusal of a failed derivation: names the run when it is not the one the command works on. */
export function refuseDerivation(
  doc: CadDocument,
  command: string,
  failure: RunFailure,
  focusRunId: string,
  code: string = failure.code,
): CommandResult {
  const where = failure.runId === focusRunId ? '' : `run ${failure.runId}: `;
  return refuse(doc, command, code, `${where}${failure.message}`, [...failure.ids], [...failure.paths], failure.detail);
}
