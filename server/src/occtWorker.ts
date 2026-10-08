/**
 * @layer server
 * Worker-thread entry for the isolated OpenCascade kernel (`isolatedKernel.ts`). Emscripten turns
 * a WASM abort into `process.exit`, which in a worker thread ends only this thread; the bootstrap
 * in `isolatedKernel.ts` flags that death in shared memory so the blocked server thread wakes.
 *
 * Protocol: `occtWorkerProtocol.ts`.
 */

import { workerData, type MessagePort } from 'node:worker_threads';
import type { GeometryKernel, ShapeHandle } from '@core/geometry/kernel';
import { keyOnlyHandle } from '@core/geometry/shapeKernel';
import { errorMessage } from '@lib/errorMessage';
import { nativeFailureCount } from '@kernel-occt/occtKernel';
import { createNodeOcctKernel } from './occtNode';
import {
  STATUS_READY,
  STATUS_REPLY,
  type KernelReply,
  type KernelRequest,
} from './occtWorkerProtocol';

interface WorkerInit {
  readonly statusBuffer: SharedArrayBuffer;
  readonly port: MessagePort;
  readonly testHooks: boolean;
}

function signal(status: Int32Array, value: number): void {
  Atomics.store(status, 0, value);
  Atomics.notify(status, 0);
}

async function main(): Promise<void> {
  const init = workerData as WorkerInit;
  const status = new Int32Array(init.statusBuffer);
  const kernel = await createNodeOcctKernel();

  init.port.on('message', (request: KernelRequest) => {
    const failuresBefore = nativeFailureCount();
    let reply: KernelReply;
    try {
      reply = { result: run(kernel, request, init.testHooks) };
    } catch (error) {
      reply = { result: null, error: errorMessage(error) };
    }
    if (nativeFailureCount() > failuresBefore) reply = { ...reply, recycle: true };
    init.port.postMessage(reply);
    signal(status, STATUS_REPLY);
  });
  signal(status, STATUS_READY);
}

function run(kernel: GeometryKernel, request: KernelRequest, testHooks: boolean): unknown {
  if (request.op === '__abort' || request.op === '__hang' || request.op === '__exitIdle') {
    if (!testHooks) throw new Error(`unknown kernel operation ${request.op}`);
    if (request.op === '__abort') process.exit(1);
    if (request.op === '__exitIdle') {
      setTimeout(() => process.exit(1), 100); // after the reply: the worker dies while idle
      return null;
    }
    for (;;);
  }
  const method = kernel[request.op] as (...args: unknown[]) => unknown;
  const result = method.apply(kernel, [...request.args]);
  // The server rebuilds the full handle from its own recipe: never clone the tree back.
  return request.op === 'evaluate' && result !== null
    ? keyOnlyHandle(result as ShapeHandle)
    : result;
}

main().catch((error: unknown) => {
  console.error('[occt-worker] failed to start:', errorMessage(error));
  process.exit(1);
});
