// Leading + trailing throttle for pointer hover: the first value applies at once, values arriving inside the window collapse to the
// last one, applied when the window ends. Clock and timers are injected (tests drive them). Pure: no React, no three.js.

export interface ThrottleClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export interface Throttled<T> {
  push(value: T): void;
  /** Drops a pending value. */
  cancel(): void;
}

const REAL_CLOCK: ThrottleClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

export function createThrottle<T>(apply: (value: T) => void, intervalMs: number, clock: ThrottleClock = REAL_CLOCK): Throttled<T> {
  let lastRun = Number.NEGATIVE_INFINITY;
  let timer: number | undefined;
  let pending: { value: T } | undefined;

  const run = (value: T): void => {
    lastRun = clock.now();
    apply(value);
  };
  const flush = (): void => {
    timer = undefined;
    const next = pending;
    pending = undefined;
    if (next !== undefined) run(next.value);
  };

  return {
    push(value) {
      const wait = lastRun + intervalMs - clock.now();
      if (timer === undefined && wait <= 0) {
        run(value);
        return;
      }
      pending = { value };
      if (timer === undefined) timer = clock.setTimeout(flush, Math.max(wait, 0));
    },
    cancel() {
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}
