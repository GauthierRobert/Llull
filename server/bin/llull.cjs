#!/usr/bin/env node
/**
 * `llull` CLI launcher. Bundles server/src/cli/bin.ts with esbuild into server/dist (~0.1 s) only
 * when a source file it imports changed since the last bundle, then runs the bundle — a warm call
 * costs plain-node startup instead of a TypeScript transpile of the whole registry.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const serverDir = path.resolve(__dirname, '..');
const outfile = path.join(serverDir, 'dist', 'llull-cli.cjs');
/** The OCC worker the CLI's isolated kernel loads (`dist/occtWorker.js`, next to the bundle); rebuilt too, or a stale worker would run old kernel code. */
const workerFile = path.join(serverDir, 'dist', 'occtWorker.js');

function isFresh(target) {
  try {
    const builtAt = fs.statSync(target).mtimeMs;
    const inputs = JSON.parse(fs.readFileSync(`${target}.inputs.json`, 'utf8'));
    return inputs.every((input) => fs.statSync(path.resolve(serverDir, input)).mtimeMs <= builtAt);
  } catch {
    return false;
  }
}

function bundle(entry, target) {
  const esbuild = require('esbuild');
  const temporary = `${target}.${process.pid}.tmp`;
  const result = esbuild.buildSync({
    entryPoints: [path.join(serverDir, entry)],
    absWorkingDir: serverDir,
    tsconfig: path.join(serverDir, 'tsconfig.json'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    packages: 'external',
    outfile: temporary,
    metafile: true,
    logLevel: 'error',
  });
  fs.writeFileSync(`${target}.inputs.json`, JSON.stringify(Object.keys(result.metafile.inputs)));
  fs.renameSync(temporary, target);
}

if (!isFresh(workerFile)) bundle(path.join('src', 'occtWorker.ts'), workerFile);
if (!isFresh(outfile)) bundle(path.join('src', 'cli', 'bin.ts'), outfile);
require(outfile);
