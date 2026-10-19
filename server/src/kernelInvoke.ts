/** Runs one `KernelOps` request on an in-thread kernel: shared by the OCC worker and the native kernel worker (its WASM fallback). */

import type { GeometryKernel, ShapeHandle } from '@core/geometry/kernel';
import { keyOnlyHandle } from '@core/geometry/shapeKernel';
import type { KernelRequest, TestHook } from './occtWorkerProtocol';

const FACE_QUERY_PREFIX = 'faceQuery.';

/** Calls the kernel method named by `request.op` (`faceQuery.<method>` resolves on the face-query port); throws for an unknown op. */
export function invokeKernelOperation(kernel: GeometryKernel, request: KernelRequest): unknown {
  if (request.op.startsWith(FACE_QUERY_PREFIX)) {
    const port = kernel.faceQuery as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined> | undefined;
    const method = port?.[request.op.slice(FACE_QUERY_PREFIX.length)];
    if (method === undefined) throw new Error(`unknown kernel operation ${request.op}`);
    return method.apply(port, [...request.args]);
  }
  const method = kernel[request.op as keyof GeometryKernel] as ((...args: unknown[]) => unknown) | undefined;
  if (typeof method !== 'function') throw new Error(`unknown kernel operation ${request.op}`);
  const result = method.apply(kernel, [...request.args]);
  // The host rebuilds the full handle from its own recipe: never clone the tree back.
  return request.op === 'evaluate' && result !== null ? keyOnlyHandle(result as ShapeHandle) : result;
}

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
