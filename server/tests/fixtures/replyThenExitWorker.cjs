// Worker entry for isolatedKernel.test.ts: becomes READY, then answers the first request by
// setting STATUS_REPLY WITHOUT notifying and exiting, so only the bootstrap exit hook can wake
// the blocked server thread (it must overwrite the unconsumed REPLY with DIED and notify).
const { workerData } = require('node:worker_threads');

const STATUS_REPLY = 1;
const STATUS_READY = 3;
const status = new Int32Array(workerData.statusBuffer);

workerData.port.on('message', () => {
  workerData.port.postMessage({ result: null });
  Atomics.store(status, 0, STATUS_REPLY);
  process.exit(1);
});
Atomics.store(status, 0, STATUS_READY);
Atomics.notify(status, 0);
