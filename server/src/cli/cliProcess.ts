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

runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  readStdin,
  env: process.env,
  prepareKernel,
  stderrIsTty: process.stderr.isTTY === true,
})
  .then((code) => {
    // Kernel workers / wasm handles would otherwise keep the process alive.
    process.exitCode = code;
    process.stdout.write('', () => process.exit(code));
  })
  .catch((error: unknown) => {
    process.stderr.write(`llull: internal error: ${String(error)}\n`);
    process.exit(1);
  });
