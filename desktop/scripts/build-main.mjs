/**
 * Bundle the Electron main process (src/main.ts) with esbuild into dist/main.js. `electron` stays
 * external (provided by the runtime); everything else, including @core helpers, is bundled.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'src', 'main.ts')],
  absWorkingDir: root,
  tsconfig: path.join(root, 'tsconfig.json'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  outfile: path.join(root, 'dist', 'main.js'),
  sourcemap: true,
  logLevel: 'warning',
});
