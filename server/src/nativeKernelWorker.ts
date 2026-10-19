/**
 * Worker-thread entry of the native OCC kernel (`nativeKernel.ts`, RS-1). Same status-word protocol as `occtWorker.ts`, so
 * `isolatedKernel.ts` drives it unchanged (synchronous calls, timeout, recycle, blob resend); here each request is routed to the
 * `llull-kernel` sidecar or, per op, to the WASM OCC kernel (`native/kernelRouter.ts`). The sidecar is spawned with `--exit-on-eof`:
 * when this worker is killed its stdin closes and it exits, even mid-operation.
 * @failure the sidecar does not answer `info` -> the worker exits (the host falls back to the WASM kernel)
 */

import { workerData, type MessagePort } from 'node:worker_threads';
import { errorMessage } from '@lib/errorMessage';
import { nativeFailureCount } from '@kernel-occt/occtKernel';
import type { CachingKernel } from '@core/geometry/shapeKernel';
import { createNodeOcctKernel } from './occtNode';
import { invokeKernelOperation, isTestHook, runTestHook } from './kernelInvoke';
import { STATUS_READY, STATUS_REPLY, type KernelReply, type KernelRequest } from './occtWorkerProtocol';
import { parseNativeInfo } from './native/kernelProtocol';
import { createKernelRouter, type FallbackRunner } from './native/kernelRouter';
import { createKernelSession, spawnKernelChild, type NativeKernelSession } from './native/kernelSession';

interface WorkerInit {
  readonly statusBuffer: SharedArrayBuffer;
  readonly port: MessagePort;
  readonly testHooks: boolean;
  readonly binary: string;
}

function signal(status: Int32Array, value: number): void {
  Atomics.store(status, 0, value);
  Atomics.notify(status, 0);
}

/** WASM requests run like `occtWorker.ts`; a degrading OCC exception asks the host to recycle the worker. */
function wasmRunner(kernel: CachingKernel): FallbackRunner {
  return (request) => {
    const failuresBefore = nativeFailureCount();
    let reply: KernelReply;
    try {
      reply = { result: invokeKernelOperation(kernel, request) };
    } catch (error) {
      reply = { result: null, error: errorMessage(error) };
    }
    return nativeFailureCount() > failuresBefore ? { ...reply, recycle: true } : reply;
  };
}

async function main(): Promise<void> {
  const init = workerData as WorkerInit;
  const status = new Int32Array(init.statusBuffer);
  const launch = (): NativeKernelSession => createKernelSession(spawnKernelChild(init.binary));
  let session = launch();
  const hello = await session.request('info', []);
  const native = parseNativeInfo(hello.result);
  if (native === null) throw new Error(`${init.binary} did not answer info (${hello.error ?? 'unexpected reply'})`);

  let wasm: Promise<FallbackRunner> | null = null;
  const router = createKernelRouter({
    native,
    session: () => {
      if (!session.alive()) {
        console.warn('[occt-native] the llull-kernel sidecar exited; starting a new one');
        session = launch();
      }
      return session;
    },
    fallback: () => (wasm ??= createNodeOcctKernel().then(wasmRunner)),
  });

  init.port.on('message', (request: KernelRequest) => {
    const { op } = request;
    const answer = isTestHook(op)
      ? new Promise<KernelReply>((resolve) => resolve({ result: runTestHook(op, init.testHooks) }))
      : router.route(request);
    void answer
      .catch((error: unknown): KernelReply => ({ result: null, error: errorMessage(error) }))
      .then((reply) => {
        init.port.postMessage(reply);
        signal(status, STATUS_REPLY);
      });
  });
  signal(status, STATUS_READY);
}

main().catch((error: unknown) => {
  console.error('[occt-native-worker] failed to start:', errorMessage(error));
  process.exit(1);
});
