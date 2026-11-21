// Captures run one at a time (ASC M6a): a second request waits for the first to finish, so two frames never share the renderer or the scene mask.
// A task whose signal is already aborted when its turn comes is skipped (the backend cancelled it).

export interface CaptureQueue {
  /** Run `task` after every earlier one; resolves with its result, or rejects with its error or with `cancelled` when `signal` aborted before it started. */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export function createCaptureQueue(): CaptureQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run: <T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
      const result = tail.then(() => {
        if (signal?.aborted === true) throw new Error('cancelled');
        return task();
      });
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
