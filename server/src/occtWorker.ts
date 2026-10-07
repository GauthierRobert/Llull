/**
 * @layer server
 * Worker-thread entry for the isolated OpenCascade kernel (`isolatedKernel.ts`). Emscripten turns
 * a WASM abort into `process.exit`, which in a worker thread ends only this thread; the bootstrap
 * in `isolatedKernel.ts` flags that death in shared memory so the blocked server thread wakes.
 *
 * Protocol: `occtWorkerProtocol.ts`.
 */

import { workerData, type MessagePort } from 'node:worker_threads';
import type { GeometryKernel } from '@core/geometry/kernel';
import { errorMessage } from '@lib/errorMessage';
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
    let reply: KernelReply;
    try {
      reply = { result: run(kernel, request, init.testHooks) };
    } catch (error) {
      reply = { result: null, error: errorMessage(error) };
    }
    init.port.postMessage(reply);
    signal(status, STATUS_REPLY);
  });
  signal(status, STATUS_READY);
}

function run(kernel: GeometryKernel, request: KernelRequest, testHooks: boolean): unknown {
  if (request.op === '__abort' || request.op === '__hang') {
    if (!testHooks) throw new Error(`unknown kernel operation ${request.op}`);
    if (request.op === '__abort') process.exit(1);
    for (;;);
  }
  const method = kernel[request.op] as (...args: unknown[]) => unknown;
  return method.apply(kernel, [...request.args]);
}

main().catch((error: unknown) => {
  console.error('[occt-worker] failed to start:', errorMessage(error));
  process.exit(1);
});
