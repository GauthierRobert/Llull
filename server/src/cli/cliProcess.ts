/**
 * The `llull` CLI process body (loaded by `bin.ts`): installs the default
 * plugins, wires real stdio, and installs the geometry kernel only when a local command runs.
 */

import '../plugins';
import { parseArgv, stringFlag } from './argv';
import { runCli } from './main';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function prepareKernel(): Promise<void> {
  const kernel = stringFlag(parseArgv(process.argv.slice(2)), 'kernel');
  if (kernel !== undefined) process.env['LLULL_KERNEL'] = kernel;
  const [{ installGeometryKernel }, { installPhysicsEngine }, { installRasterPort }] = await Promise.all([
    import('../geometryKernel'),
    import('../physicsEngine'),
    import('../native/rasterPort'),
  ]);
  installRasterPort();
  await Promise.all([installGeometryKernel(), installPhysicsEngine()]);
}

/** A handle still open this long after the run (a kernel worker, a wasm instance) no longer delays the exit. */
const FORCED_EXIT_MS = 10_000;

/**
 * Ends the process by letting the event loop drain, not with an immediate `process.exit`: a natural exit waits for V8's
 * background tasks, while `process.exit` tears the platform down under them. On Windows (Node 24) a background wasm
 * compile (fetch's llhttp after an `--app` / `--server` call) then posts to a closed libuv handle and the process aborts
 * with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (src\win\async.c). The unref'd timer only fires when
 * something still holds the loop open.
 */
function exitWhenDrained(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), FORCED_EXIT_MS).unref();
}

runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  readStdin,
  env: process.env,
  prepareKernel,
  stderrIsTty: process.stderr.isTTY === true,
})
  .then((code) => exitWhenDrained(code))
  .catch((error: unknown) => {
    process.stderr.write(`llull: internal error: ${String(error)}\n`);
    exitWhenDrained(1);
  });
