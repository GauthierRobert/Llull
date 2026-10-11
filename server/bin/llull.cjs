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
const metaFile = `${outfile}.inputs.json`;

function isFresh() {
  try {
    const builtAt = fs.statSync(outfile).mtimeMs;
    const inputs = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    return inputs.every((input) => fs.statSync(path.resolve(serverDir, input)).mtimeMs <= builtAt);
  } catch {
    return false;
  }
}

function bundle() {
  const esbuild = require('esbuild');
  const temporary = `${outfile}.${process.pid}.tmp`;
  const result = esbuild.buildSync({
    entryPoints: [path.join(serverDir, 'src', 'cli', 'bin.ts')],
    absWorkingDir: serverDir,
    tsconfig: path.join(serverDir, 'tsconfig.json'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    packages: 'external',
    outfile: temporary,
    metafile: true,
    logLevel: 'error',
  });
  fs.writeFileSync(metaFile, JSON.stringify(Object.keys(result.metafile.inputs)));
  fs.renameSync(temporary, outfile);
}

if (!isFresh()) bundle();
require(outfile);
