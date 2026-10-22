#!/usr/bin/env node
// Builds OpenCascade (OCCT) as SHARED libraries for the native kernel (RS-1, LGPL-2.1 dynamic linking).
//
// One pinned source (the Ubuntu archive's dfsg tarball of the upstream V7_9_2 tag, sha256-verified), one cmake recipe,
// one install prefix (include/ + lib/ + licence texts). Used by local dev, CI (cached by version + sha) and desktop bundling.
//
//   node solver/scripts/build-occt.mjs            build (or reuse) the default prefix, print it
//   node solver/scripts/build-occt.mjs --print    print the default prefix only (no build)
//   LLULL_OCCT_DIR=<dir> ...                      install into <dir> instead of the default prefix
//   LLULL_OCCT_JOBS=<n> ...                       parallel compile jobs (default: CPU count)
//
// The default prefix is per user, shared by every checkout and worktree (the build takes ~45-60 min on 4 cores):
//   Linux  ${XDG_CACHE_HOME:-~/.cache}/llull/occt-<version>
//   macOS  ~/Library/Caches/llull/occt-<version>
//   Win    %LOCALAPPDATA%\llull\occt-<version>
// solver/crates/llull-kernel-occt/build.rs resolves the same default when LLULL_OCCT_DIR is unset.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus, homedir, platform } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

export const OCCT_VERSION = '7.9.2';
const SOURCE_URL = `http://archive.ubuntu.com/ubuntu/pool/universe/o/opencascade/opencascade_${OCCT_VERSION}+dfsg.orig.tar.xz`;
export const SOURCE_SHA256 = 'f6e272b6aaa14743a611eb4b8d7affa98986cdcaa60f5a91ca7ac46b177b7181';
const SOURCE_DIR_NAME = 'occt-V7_9_2';

// First-level toolkits; OCCT's cmake adds their dependencies (TKXCAF pulls TKVCAF/TKV3d/TKService/TKHLR, built without any
// windowing or font backend below). Keep in step with OCCT_LIBS in solver/crates/llull-kernel-occt/build.rs; TKDESTL is for Netgen
// only (solver/scripts/build-netgen.mjs links its OCC geometry against this prefix and needs it).
const TOOLKITS = [
  'TKernel',
  'TKMath',
  'TKG2d',
  'TKG3d',
  'TKGeomBase',
  'TKBRep',
  'TKGeomAlgo',
  'TKTopAlgo',
  'TKPrim',
  'TKBO',
  'TKBool',
  'TKFillet',
  'TKOffset',
  'TKFeat',
  'TKMesh',
  'TKShHealing',
  'TKXSBase',
  'TKDE',
  'TKDESTEP',
  'TKDEIGES',
  'TKDESTL',
  'TKCDF',
  'TKLCAF',
  'TKCAF',
  'TKXCAF',
];
const MODULES = [
  'FoundationClasses',
  'ModelingData',
  'ModelingAlgorithms',
  'Visualization',
  'ApplicationFramework',
  'DataExchange',
  'DETools',
  'Draw',
];
const OFF = [
  'USE_TK',
  'USE_TCL',
  'USE_FREETYPE',
  'USE_FREEIMAGE',
  'USE_FFMPEG',
  'USE_OPENVR',
  'USE_RAPIDJSON',
  'USE_DRACO',
  'USE_TBB',
  'USE_EIGEN',
  'USE_VTK',
  'USE_XLIB',
  'USE_OPENGL',
  'USE_GLES2',
  'USE_D3D',
  'BUILD_DOC_Overview',
  'BUILD_USE_PCH',
];
const STAMP = 'llull-occt.json';
// Bumped whenever the compile recipe changes the binaries, so a prefix built by an older recipe is rebuilt (the stamp records it).
// 2: GCC builds pass -fno-ipa-cp-clone (docs/decisions/SV1-solver-toolchain-windows.md, "MinGW OCCT access violation").
const RECIPE = 2;
// GCC 16.2 at -O3 miscompiles OCCT: an IPA-CP clone of NCollection_UBTree::Select specialised (devirtualised) for one selector type
// is called for another (BRepClass3d_SClassifier::Perform runs the line selector's Reject / Accept on its point selector), an access
// violation in every solid classification (distance, booleans, shell). Injected after project() so it applies to GCC only.
const GCC_WORKAROUND_CMAKE = `if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
  add_compile_options(-fno-ipa-cp-clone)
endif()
`;

export function defaultOcctPrefix() {
  const os = platform();
  const base =
    os === 'darwin'
      ? join(homedir(), 'Library', 'Caches')
      : os === 'win32'
        ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
        : (process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'));
  return join(base, 'llull', `occt-${OCCT_VERSION}`);
}

export function occtPrefix() {
  return process.env.LLULL_OCCT_DIR ?? defaultOcctPrefix();
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

async function download(target) {
  if (existsSync(target) && (await sha256(target)) === SOURCE_SHA256) return;
  console.warn(`downloading ${SOURCE_URL}`);
  const response = await fetch(SOURCE_URL);
  if (!response.ok || !response.body) throw new Error(`download failed: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${target}.part`));
  const actual = await sha256(`${target}.part`);
  if (actual !== SOURCE_SHA256) throw new Error(`sha256 mismatch for ${SOURCE_URL}: ${actual}`);
  renameSync(`${target}.part`, target);
}

function stampMatches(prefix) {
  try {
    const stamp = JSON.parse(readFileSync(join(prefix, STAMP), 'utf8'));
    // a prefix built before a toolkit joined TOOLKITS is rebuilt too
    const built = new Set(stamp.toolkits ?? []);
    return (
      stamp.version === OCCT_VERSION &&
      stamp.sha256 === SOURCE_SHA256 &&
      stamp.recipe === RECIPE &&
      TOOLKITS.every((toolkit) => built.has(toolkit))
    );
  } catch {
    return false;
  }
}

function cmakeArgs(sourceDir, prefix, projectInclude) {
  const os = platform();
  const args = [
    '-S',
    sourceDir,
    `-DCMAKE_PROJECT_INCLUDE=${projectInclude}`,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_INSTALL_PREFIX=${prefix}`,
    '-DBUILD_LIBRARY_TYPE=Shared',
    `-DBUILD_ADDITIONAL_TOOLKITS=${TOOLKITS.join(';')}`,
    '-DINSTALL_DIR_LIB=lib',
    '-DINSTALL_DIR_BIN=bin',
    '-DINSTALL_DIR_INCLUDE=include/opencascade',
    '-DINSTALL_SAMPLES=OFF',
    '-DINSTALL_TEST_CASES=OFF',
    ...MODULES.map((module) => `-DBUILD_MODULE_${module}=OFF`),
    ...OFF.map((option) => `-D${option}=OFF`),
  ];
  // Each toolkit finds its sibling toolkits next to itself, so the bundle works from any directory (RUNPATH is not transitive).
  if (os === 'linux') args.push('-DCMAKE_INSTALL_RPATH=$ORIGIN', '-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON');
  if (os === 'darwin')
    args.push('-DCMAKE_INSTALL_NAME_DIR=@rpath', '-DCMAKE_INSTALL_RPATH=@loader_path', '-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON');
  if (has('ninja')) args.push('-G', 'Ninja');
  return args;
}

export async function buildOcct(prefix = occtPrefix()) {
  if (stampMatches(prefix)) return prefix;
  const work = `${prefix}.work`;
  mkdirSync(work, { recursive: true });
  const tarball = join(work, `opencascade_${OCCT_VERSION}+dfsg.orig.tar.xz`);
  await download(tarball);
  const sourceDir = join(work, SOURCE_DIR_NAME);
  // Relative archive name: GNU tar (Git for Windows) reads `C:\…` as a remote host.
  if (!existsSync(join(sourceDir, 'CMakeLists.txt'))) run('tar', ['-xJf', basename(tarball)], work);
  const buildDir = join(work, 'build');
  const projectInclude = join(work, 'llull-compiler-workarounds.cmake');
  writeFileSync(projectInclude, GCC_WORKAROUND_CMAKE);
  run('cmake', [...cmakeArgs(sourceDir, prefix, projectInclude.replaceAll('\\', '/')), '-B', buildDir]);
  const jobs = process.env.LLULL_OCCT_JOBS ?? String(cpus().length);
  run('cmake', ['--build', buildDir, '--config', 'Release', '--parallel', jobs]);
  rmSync(prefix, { recursive: true, force: true });
  run('cmake', ['--install', buildDir, '--config', 'Release']);
  for (const notice of ['LICENSE_LGPL_21.txt', 'OCCT_LGPL_EXCEPTION.txt']) cpSync(join(sourceDir, notice), join(prefix, notice));
  writeFileSync(
    join(prefix, STAMP),
    `${JSON.stringify({ version: OCCT_VERSION, sha256: SOURCE_SHA256, recipe: RECIPE, source: SOURCE_URL, toolkits: TOOLKITS }, null, 2)}\n`,
  );
  if (!process.env.LLULL_OCCT_KEEP_WORK) rmSync(work, { recursive: true, force: true });
  return prefix;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--print')) {
    process.stdout.write(`${occtPrefix()}\n`);
  } else {
    const prefix = await buildOcct();
    process.stdout.write(`${prefix}\n`);
  }
}
