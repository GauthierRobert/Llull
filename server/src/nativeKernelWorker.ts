/**
 * Worker-thread entry of the native OCC kernel (`nativeKernel.ts`, RS-1). The status-word protocol is `kernelWorkerProtocol.ts`, driven by
 * `isolatedKernel.ts` (synchronous calls, timeout, restart, blob resend); each request is routed to the `llull-kernel` sidecar
 * (`native/kernelRouter.ts`). The sidecar is spawned with `--exit-on-eof`: when this worker is killed its stdin closes and it exits,
 * even mid-operation.
 * @failure the sidecar does not answer `info` -> the worker exits (the host falls back to Manifold)
 */

import { workerData, type MessagePort } from 'node:worker_threads';
import { errorMessage } from '@lib/errorMessage';
import { isTestHook, runTestHook } from './kernelTestHooks';
import { STATUS_READY, STATUS_REPLY, type KernelReply, type KernelRequest } from './kernelWorkerProtocol';
import { parseNativeInfo } from './native/kernelProtocol';
import { createKernelRouter } from './native/kernelRouter';
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

async function main(): Promise<void> {
  const init = workerData as WorkerInit;
  const status = new Int32Array(init.statusBuffer);
  const launch = (): NativeKernelSession => createKernelSession(spawnKernelChild(init.binary));
  let session = launch();
  const hello = await session.request('info', []);
  const native = parseNativeInfo(hello.result);
  if (native === null) throw new Error(`${init.binary} did not answer info (${hello.error ?? 'unexpected reply'})`);

  const router = createKernelRouter({
    native,
    session: () => {
      if (!session.alive()) {
        console.warn('[occt-native] the llull-kernel sidecar exited; starting a new one');
        session = launch();
      }
      return session;
    },
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
