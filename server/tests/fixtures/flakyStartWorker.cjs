// Worker entry for isolatedKernel.test.ts: a fake kernel speaking the status-word protocol.
// Load #1 (the warm restart after `__abort`) dies on start; every other load answers each
// request with `{ loads }`. The load counter lives in a temp file keyed by the process pid.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { workerData } = require('node:worker_threads');

const STATUS_REPLY = 1;
const STATUS_READY = 3;
const counterFile = path.join(os.tmpdir(), `llull-flaky-worker-${process.pid}`);
const loads = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0;
fs.writeFileSync(counterFile, String(loads + 1));
if (loads === 1) process.exit(1);

const status = new Int32Array(workerData.statusBuffer);
workerData.port.on('message', (request) => {
  if (request.op === '__abort') process.exit(1);
  workerData.port.postMessage({ result: { loads } });
  Atomics.store(status, 0, STATUS_REPLY);
  Atomics.notify(status, 0);
});
Atomics.store(status, 0, STATUS_READY);
Atomics.notify(status, 0);
