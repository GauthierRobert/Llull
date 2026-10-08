/**
 * @layer ui/store
 * Dispatches still inside their connect grace period (see `CONNECT_GRACE_MS` in ./onlineMode),
 * in dispatch order. Shared by ./onlineMode (tracks them) and ./outbox (resets them).
 */

/** A dispatch whose grace timer is armed and whose POST has not settled yet. */
export interface PendingGraceRun {
  readonly dispatchSeq: number;
  /** Cancel the grace timer and run the command locally now (no-op if it already ran). */
  readonly runNow: () => void;
  /** Cancel the grace timer and ignore the POST outcome: the command never runs locally. */
  readonly cancel: () => void;
}

let lastDispatchSeq = 0;
/** In dispatch order. */
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

/** Document replaced: cancel every pending grace run and restart the dispatch sequence. */
export function resetGraceRuns(): void {
  for (const pending of pendingGraceRuns.splice(0)) pending.cancel();
  lastDispatchSeq = 0;
}
