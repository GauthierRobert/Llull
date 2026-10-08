/**
 * @layer server
 *
 * Node loader for the OCC kernel. `opencascade.js`'s index imports the .wasm as an ES module
 * (unsupported by Node), so evaluate the Emscripten glue directly and feed it the WASM bytes.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { CachingKernel } from '@core/geometry/shapeKernel';
import { createOcctKernel, type OcctFactory } from '@kernel-occt/occtKernel';

export async function createNodeOcctKernel(): Promise<CachingKernel> {
  const distDir = join(dirname(createRequire(__filename).resolve('opencascade.js')), 'dist');
  const gluePath = join(distDir, 'opencascade.wasm.js');
  const glueSource = (await readFile(gluePath, 'utf8')).replace(
    /export default opencascade;\s*$/,
    'module.exports = opencascade;',
  );
  const glueModule: { exports: unknown } = { exports: {} };
  new Function('module', 'exports', 'require', '__filename', '__dirname', glueSource)(
    glueModule,
    glueModule.exports,
    createRequire(gluePath),
    gluePath,
    distDir,
  );
  const wasmBinary = await readFile(join(distDir, 'opencascade.wasm.wasm'));
  return createOcctKernel({ factory: glueModule.exports as OcctFactory, wasmBinary });
}
