// Coalesces bursts of requests into one run per animation frame (the latest request wins). Injected frame source keeps it testable.

export interface FrameScheduler {
  /** Run `job` on the next frame; replaces a job still waiting. */
  schedule(job: () => void): void;
  cancel(): void;
}

export function createFrameScheduler(request: (callback: () => void) => number, cancelFrame: (handle: number) => void): FrameScheduler {
  let pending: (() => void) | null = null;
  let handle: number | null = null;
  return {
    schedule(job): void {
      pending = job;
      if (handle !== null) return;
      handle = request(() => {
        handle = null;
        const run = pending;
        pending = null;
        run?.();
      });
    },
    cancel(): void {
      if (handle !== null) cancelFrame(handle);
      handle = null;
      pending = null;
    },
  };
}
