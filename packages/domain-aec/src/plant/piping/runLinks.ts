/**
 * Which runs read another run (02 RTE M2): a run that continues from another run's end (`runEnd` reference) and a branch run (`branch` reference
 * to a branch point of its header) are derived from the run they are attached to, so a change to that run re-derives them.
 */

import type { PipeRun, PipingModel, PortRef } from '@aec/plant/types';

/** The run `ref` is attached to, or undefined for a tie-in / nozzle / open end. */
export const refRunId = (ref: PortRef | undefined): string | undefined =>
  ref?.kind === 'runEnd' || ref?.kind === 'branch' ? ref.runId : undefined;

/** The runs attached to `runId` directly, in run order. */
export const attachedRunIds = (piping: PipingModel, runId: string): string[] =>
  piping.runOrder.filter((id) => {
    const run = piping.runs[id] as PipeRun | undefined;
    return run !== undefined && [run.start.ref, run.end.ref].some((ref) => refRunId(ref) === runId);
  });

/** `runId` followed by every run that is attached to it directly or through other attached runs (cycle-safe, run order). */
export function withDependents(piping: PipingModel, runId: string): string[] {
  const reached = new Set<string>([runId]);
  const queue = [runId];
  while (queue.length > 0) {
    for (const id of attachedRunIds(piping, queue.shift() as string)) {
      if (reached.has(id)) continue;
      reached.add(id);
      queue.push(id);
    }
  }
  return [runId, ...piping.runOrder.filter((id) => reached.has(id) && id !== runId)];
}

/** `runIds` plus every run attached to them in either direction (their headers, branches and continuations), in run order. */
export function connectedRuns(piping: PipingModel, runIds: readonly string[]): string[] {
  const reached = new Set<string>(runIds);
  const queue = [...runIds];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const run = piping.runs[id] as PipeRun | undefined;
    const neighbours = [...attachedRunIds(piping, id), refRunId(run?.start.ref), refRunId(run?.end.ref)];
    for (const next of neighbours) {
      if (next === undefined || reached.has(next) || piping.runs[next] === undefined) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return piping.runOrder.filter((id) => reached.has(id));
}
