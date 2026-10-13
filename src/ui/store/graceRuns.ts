// Dispatches inside their connect grace period (CONNECT_GRACE_MS), in dispatch order: tracked by onlineMode, reset by outbox.

/** Grace timer armed, POST not settled. */
export interface PendingGraceRun {
  readonly dispatchSeq: number;
  /** Run locally now (no-op if it already ran). */
  readonly runNow: () => void;
  /** Ignore the POST outcome: never runs locally. */
  readonly cancel: () => void;
}

let lastDispatchSeq = 0;
const pendingGraceRuns: PendingGraceRun[] = [];

export function nextDispatchSeq(): number {
  lastDispatchSeq += 1;
  return lastDispatchSeq;
}

export function trackGraceRun(pending: PendingGraceRun): void {
  pendingGraceRuns.push(pending);
}

export function forgetGraceRun(dispatchSeq: number): void {
  const index = pendingGraceRuns.findIndex((pending) => pending.dispatchSeq === dispatchSeq);
  if (index >= 0) pendingGraceRuns.splice(index, 1);
}

/**
 * @invariant local run order = dispatch order: before a command falls back locally, every
 * earlier dispatch still inside its grace period runs first (a hung POST must not reorder them).
 */
export function runEarlierGraceRuns(dispatchSeq: number): void {
  while (pendingGraceRuns[0] !== undefined && pendingGraceRuns[0].dispatchSeq < dispatchSeq) {
    pendingGraceRuns.shift()?.runNow();
  }
}

/** Document replaced: cancel all and restart the dispatch sequence. */
export function resetGraceRuns(): void {
  for (const pending of pendingGraceRuns.splice(0)) pending.cancel();
  lastDispatchSeq = 0;
}
