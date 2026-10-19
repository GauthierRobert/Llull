/** Crash-test hooks of the native kernel worker (`IsolatedKernelOptions.testHooks`). */

import type { TestHook } from './kernelWorkerProtocol';

export function isTestHook(op: string): op is TestHook {
  return op === '__abort' || op === '__hang' || op === '__exitIdle';
}

/** Crash-test hooks of a kernel worker (`IsolatedKernelOptions.testHooks`): die now, die after replying, or hang. */
export function runTestHook(op: TestHook, enabled: boolean): null {
  if (!enabled) throw new Error(`unknown kernel operation ${op}`);
  if (op === '__abort') process.exit(1);
  if (op === '__exitIdle') {
    setTimeout(() => process.exit(1), 100); // after the reply: the worker dies while idle
    return null;
  }
  for (;;);
}
