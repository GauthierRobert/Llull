/**
 * Bundle the Electron main process (src/main.ts) and the preload script (src/preload.ts) with esbuild into dist/. `electron` stays
 * external (provided by the runtime); everything else, including @core helpers, is bundled.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The main bundle must stay free of native modules (an `.node` addon or the SVG rasterizer pulled in through the server code): the build fails on them. */
const noNativeModules = {
  name: 'no-native-modules',
  setup(build) {
    build.onResolve({ filter: /\.node$|^@resvg\// }, (args) => ({
      errors: [
        {
          text: `native module ${args.path} reached the desktop main bundle (imported from ${args.importer}); keep it out (see server/src/hostedFile.ts)`,
        },
      ],
    }));
  },
};

await build({
  entryPoints: [path.join(root, 'src', 'main.ts'), path.join(root, 'src', 'preload.ts')],
  absWorkingDir: root,
  tsconfig: path.join(root, 'tsconfig.json'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  outdir: process.env['LLULL_DESKTOP_OUT'] ?? path.join(root, 'dist'),
  plugins: [noNativeModules],
  sourcemap: true,
  logLevel: 'warning',
});
