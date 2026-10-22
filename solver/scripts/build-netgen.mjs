#!/usr/bin/env node
// Builds Netgen (nglib + ngcore) as SHARED libraries for the FE mesher llull-mesh (LGPL-2.1 dynamic linking,
// docs/decisions/NG1-netgen-mesher.md), against the OCCT prefix of solver/scripts/build-occt.mjs (the same OCCT the kernel links).
//
// Pinned sources (sha256-verified): the upstream Netgen release tag and zlib (linked statically into nglib; zlib licence). No Python,
// no GUI, no superbuild. One install prefix: include/ + lib/ (+ bin/ on Windows) + licence texts + llull-netgen.json.
//
//   node solver/scripts/build-netgen.mjs            build (or reuse) the default prefix (and the OCCT prefix it needs), print it
//   node solver/scripts/build-netgen.mjs --print    print the default prefix only (no build)
//   LLULL_NETGEN_DIR=<dir> ...                      install into <dir> instead of the default prefix
//   LLULL_OCCT_DIR=<dir> ...                        the OCCT prefix to build against (else build-occt.mjs's default, built if missing)
//   LLULL_NETGEN_JOBS=<n> ...                       parallel compile jobs (default: CPU count)
//
// The default prefix is per user, shared by every checkout and worktree, next to the OCCT one:
//   Linux  ${XDG_CACHE_HOME:-~/.cache}/llull/netgen-<version>     macOS  ~/Library/Caches/llull/netgen-<version>
//   Win    %LOCALAPPDATA%\llull\netgen-<version>
// solver/crates/llull-netgen/build.rs resolves the same default when LLULL_NETGEN_DIR is unset. The stamp records the OCCT prefix and its
// stamp: a rebuilt OCCT rebuilds Netgen.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus, homedir, platform } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { buildOcct, occtPrefix } from './build-occt.mjs';

export const NETGEN_VERSION = '6.2.2604';
const SOURCE_URL = `https://github.com/NGSolve/netgen/archive/refs/tags/v${NETGEN_VERSION}.tar.gz`;
export const SOURCE_SHA256 = '0a614193ee6106c0c276a1516639bef872f2f2371dec159e1b1f6ffcb425954c';
const SOURCE_DIR_NAME = `netgen-${NETGEN_VERSION}`;
const ZLIB_VERSION = '1.3.1';
const ZLIB_URL = `https://github.com/madler/zlib/releases/download/v${ZLIB_VERSION}/zlib-${ZLIB_VERSION}.tar.gz`;
const ZLIB_SHA256 = '9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23';
const STAMP = 'llull-netgen.json';
// Bumped whenever the recipe changes the binaries, so a prefix built by an older recipe is rebuilt.
const RECIPE = 1;
const ON = ['USE_OCC', 'USE_STLGEOM', 'USE_INTERFACE'];
// CSG / 2D geometry stay on: nglib's own sources reference them.
const OFF = [
  'USE_SUPERBUILD',
  'USE_PYTHON',
  'USE_GUI',
  'USE_MPI',
  'USE_JPEG',
  'USE_MPEG',
  'USE_CGNS',
  'USE_NATIVE_ARCH',
  'USE_CCACHE',
  'ENABLE_UNIT_TESTS',
  'BUILD_STUB_FILES',
  'INSTALL_PROFILES',
];

export function defaultNetgenPrefix() {
  const os = platform();
  const base =
    os === 'darwin'
      ? join(homedir(), 'Library', 'Caches')
      : os === 'win32'
        ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
        : (process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'));
  return join(base, 'llull', `netgen-${NETGEN_VERSION}`);
}

export function netgenPrefix() {
  return process.env.LLULL_NETGEN_DIR ?? defaultNetgenPrefix();
}

/** The shared Netgen libraries the loader asks for (nglib + ngcore): Windows DLLs in bin/, else lib/. */
export function netgenRuntimeDir(prefix) {
  return platform() === 'win32' ? join(prefix, 'bin') : join(prefix, 'lib');
}

function run(command, args, cwd) {
  console.warn(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}

function has(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function download(url, expected, target) {
  if (existsSync(target) && (await sha256(target)) === expected) return;
  console.warn(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`download failed: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${target}.part`));
  const actual = await sha256(`${target}.part`);
  if (actual !== expected) throw new Error(`sha256 mismatch for ${url}: ${actual}`);
  renameSync(`${target}.part`, target);
}

/** sha256 of the OCCT prefix's stamp: which OCCT build Netgen was linked against. */
function occtStamp(prefix) {
  try {
    return createHash('sha256')
      .update(readFileSync(join(prefix, 'llull-occt.json')))
      .digest('hex');
  } catch {
    return null;
  }
}

function stampMatches(prefix, occt) {
  try {
    const stamp = JSON.parse(readFileSync(join(prefix, STAMP), 'utf8'));
    return (
      stamp.version === NETGEN_VERSION &&
      stamp.sha256 === SOURCE_SHA256 &&
      stamp.recipe === RECIPE &&
      stamp.occt?.prefix === occt &&
      stamp.occt?.stampSha256 === occtStamp(occt)
    );
  } catch {
    return false;
  }
}

/** OCCT's CMake package directory inside its prefix (Windows: cmake/, else lib/cmake/opencascade). */
function occtCmakeDir(prefix) {
  for (const dir of [join(prefix, 'cmake'), join(prefix, 'lib', 'cmake', 'opencascade')])
    if (existsSync(join(dir, 'OpenCASCADEConfig.cmake'))) return dir;
  throw new Error(`no OpenCASCADEConfig.cmake under ${prefix} (rebuild it with build-occt.mjs)`);
}

/** zlib as a static, position-independent library; returns { include, library }. */
function buildZlib(work, tarball) {
  const sourceDir = join(work, `zlib-${ZLIB_VERSION}`);
  if (!existsSync(join(sourceDir, 'CMakeLists.txt'))) run('tar', ['-xzf', basename(tarball)], work);
  const buildDir = join(work, 'zlib-build');
  const generator = has('ninja') ? ['-G', 'Ninja'] : [];
  run('cmake', ['-S', sourceDir, '-B', buildDir, '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POSITION_INDEPENDENT_CODE=ON', ...generator]);
  run('cmake', ['--build', buildDir, '--config', 'Release', '--target', 'zlibstatic']);
  const names = ['zlibstatic.lib', 'libz.a', 'libzlibstatic.a'];
  const found = [buildDir, join(buildDir, 'Release')]
    .flatMap((dir) => names.map((name) => join(dir, name)))
    .find((file) => existsSync(file));
  if (found === undefined) throw new Error(`zlib static library not found in ${buildDir}`);
  return { include: `${buildDir};${sourceDir}`, library: found };
}

/**
 * Linux / macOS: nglib and ngcore find OCCT next to themselves, in the sibling `occt/lib` of the desktop bundle (`netgen/lib`), and in the
 * OCCT prefix they were built against (dev builds). Netgen sets CMAKE_INSTALL_RPATH itself, so the targets are patched at the end of the
 * configure step instead.
 */
function rpathCmake(occtLib) {
  const token = platform() === 'darwin' ? '@loader_path' : '$ORIGIN';
  const rpath = [token, `${token}/../../occt/lib`, occtLib].join(';');
  return `if(NOT WIN32)
  cmake_language(DEFER DIRECTORY \${CMAKE_SOURCE_DIR} CALL set_target_properties nglib ngcore PROPERTIES INSTALL_RPATH "${rpath}" BUILD_WITH_INSTALL_RPATH ON)
endif()
`;
}

function cmakeArgs(sourceDir, prefix, occt, zlib, projectInclude) {
  const os = platform();
  const args = [
    '-S',
    sourceDir,
    `-DCMAKE_PROJECT_INCLUDE=${projectInclude}`,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_INSTALL_PREFIX=${prefix}`,
    `-DNETGEN_VERSION_GIT=v${NETGEN_VERSION}-0`,
    // Netgen asks for package `OpenCascade` (NAMES OpenCASCADE opencascade): the hint variable is OpenCascade_DIR. No package registry, so
    // an OCCT some other build registered is never picked up.
    `-DOpenCascade_DIR=${occtCmakeDir(occt).replaceAll('\\', '/')}`,
    '-DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF',
    `-DZLIB_INCLUDE_DIRS=${zlib.include.replaceAll('\\', '/')}`,
    `-DZLIB_LIBRARIES=${zlib.library.replaceAll('\\', '/')}`,
    '-DNG_INSTALL_DIR_LIB=lib',
    '-DNG_INSTALL_DIR_BIN=bin',
    '-DNG_INSTALL_DIR_INCLUDE=include/netgen',
    '-DNG_INSTALL_DIR_CMAKE=lib/cmake/netgen',
    '-DNG_INSTALL_DIR_RES=share',
    ...ON.map((option) => `-D${option}=ON`),
    ...OFF.map((option) => `-D${option}=OFF`),
  ];
  if (os === 'darwin') args.push('-DCMAKE_INSTALL_NAME_DIR=@rpath');
  if (has('ninja')) args.push('-G', 'Ninja');
  return args;
}

export async function buildNetgen(prefix = netgenPrefix(), occt = occtPrefix()) {
  await buildOcct(occt);
  if (stampMatches(prefix, occt)) return prefix;
  const work = `${prefix}.work`;
  mkdirSync(work, { recursive: true });
  const tarball = join(work, `netgen-${NETGEN_VERSION}.tar.gz`);
  const zlibTarball = join(work, `zlib-${ZLIB_VERSION}.tar.gz`);
  await download(SOURCE_URL, SOURCE_SHA256, tarball);
  await download(ZLIB_URL, ZLIB_SHA256, zlibTarball);
  const zlib = buildZlib(work, zlibTarball);
  const sourceDir = join(work, SOURCE_DIR_NAME);
  // Relative archive name: GNU tar (Git for Windows) reads `C:\…` as a remote host.
  if (!existsSync(join(sourceDir, 'CMakeLists.txt'))) run('tar', ['-xzf', basename(tarball)], work);
  // A release tarball is no git checkout: the version script (re-run at build time) reads version.txt instead of `git describe`.
  writeFileSync(join(sourceDir, 'version.txt'), `v${NETGEN_VERSION}-0\n`);
  const buildDir = join(work, 'build');
  const projectInclude = join(work, 'llull-netgen-rpath.cmake');
  writeFileSync(projectInclude, rpathCmake(join(occt, 'lib').replaceAll('\\', '/')));
  run('cmake', [...cmakeArgs(sourceDir, prefix, occt, zlib, projectInclude.replaceAll('\\', '/')), '-B', buildDir]);
  const jobs = process.env.LLULL_NETGEN_JOBS ?? String(cpus().length);
  run('cmake', ['--build', buildDir, '--config', 'Release', '--parallel', jobs]);
  rmSync(prefix, { recursive: true, force: true });
  run('cmake', ['--install', buildDir, '--config', 'Release']);
  cpSync(join(sourceDir, 'LICENSE'), join(prefix, 'LICENSE_LGPL_21.txt'));
  cpSync(join(sourceDir, 'AUTHORS'), join(prefix, 'AUTHORS.txt'));
  const zlibLicence = readdirSync(join(work, `zlib-${ZLIB_VERSION}`)).find((name) => name === 'LICENSE' || name === 'README');
  if (zlibLicence !== undefined) cpSync(join(work, `zlib-${ZLIB_VERSION}`, zlibLicence), join(prefix, 'zlib-LICENSE.txt'));
  writeFileSync(
    join(prefix, STAMP),
    `${JSON.stringify(
      {
        version: NETGEN_VERSION,
        sha256: SOURCE_SHA256,
        recipe: RECIPE,
        source: SOURCE_URL,
        zlib: { version: ZLIB_VERSION, sha256: ZLIB_SHA256, source: ZLIB_URL, linking: 'static (zlib licence)' },
        occt: { prefix: occt, stampSha256: occtStamp(occt) },
      },
      null,
      2,
    )}\n`,
  );
  if (!process.env.LLULL_NETGEN_KEEP_WORK) rmSync(work, { recursive: true, force: true });
  return prefix;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--print')) {
    process.stdout.write(`${netgenPrefix()}\n`);
  } else {
    const prefix = await buildNetgen();
    process.stdout.write(`${prefix}\n`);
  }
}
