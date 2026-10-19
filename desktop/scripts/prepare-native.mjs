/**
 * Bundle the native binaries (docs/decisions/RS1-native-compute.md) into build/native (shipped as resources/native; the desktop
 * backend gets LLULL_NATIVE_DIR only when it exists):
 *
 *   build/native/llull-compute[.exe]   jobs (fatigue/map post-processing, field raster) — built WITH the `gpu` feature: the raster job
 *                                      draws with wgpu when an adapter exists and falls back to the bit-exact CPU twin otherwise
 *   build/native/llull-kernel[.exe]    native OCCT kernel sidecar (the exact kernel: LLULL_KERNEL=occt-native is the desktop default, KI7)
 *   build/native/occt/lib/             shared OCCT toolkits, LGPL-2.1 dynamic linking (Linux .so.<maj>.<min>, macOS .<maj>.<min>.dylib;
 *                                      Windows: the DLLs sit next to the executables instead, where the loader looks)
 *   build/native/licenses/             OCCT LGPL-2.1 + exception + source/relink notice, fdlibm/V8 notice, Rust crate licences
 *   build/native/LLULL_NATIVE.json     what was bundled (versions, features, OCCT source sha256)
 *
 * Build each OS on that OS. Env:
 *   LLULL_NATIVE_PREBUILT_DIR   take llull-compute / llull-kernel from this directory instead of building them with cargo
 *   LLULL_NATIVE_GPU=0          build llull-compute without the `gpu` feature (CPU twin only)
 *   LLULL_NATIVE_KERNEL=0       bundle llull-compute only (no llull-kernel, no OCCT)
 *   LLULL_OCCT_DIR              OCCT install prefix (else solver/scripts/build-occt.mjs builds or reuses its default prefix)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '..');
const solver = path.join(repo, 'solver');
const nativeDir = path.join(desktop, 'build', 'native');
/** Own cargo target dir: the bundle's runtime search path names no build directory, the dev build in solver/target keeps its own. */
const cargoTarget = path.join(desktop, 'build', 'cargo-target');
const exe = process.platform === 'win32' ? '.exe' : '';
const withKernel = process.env.LLULL_NATIVE_KERNEL !== '0';
const withGpu = process.env.LLULL_NATIVE_GPU !== '0';

const occt = await import(pathToFileURL(path.join(solver, 'scripts', 'build-occt.mjs')).href);

function log(message) {
  console.warn(`[prepare-native] ${message}`);
}

function cargo(args, env) {
  log(`cargo ${args.join(' ')}`);
  const run = spawnSync('cargo', args, { cwd: solver, stdio: 'inherit', env: { ...process.env, ...env } });
  if (run.status !== 0) throw new Error(`cargo ${args[0]} failed (${run.status ?? run.signal})`);
}

function binaries(occtPrefix) {
  const prebuilt = process.env.LLULL_NATIVE_PREBUILT_DIR;
  if (prebuilt) return { compute: prebuilt, kernel: prebuilt };
  const rustTarget = { CARGO_TARGET_DIR: cargoTarget };
  cargo(['build', '--profile', 'compute', '-p', 'llull-compute', ...(withGpu ? ['--features', 'gpu'] : [])], rustTarget);
  if (withKernel)
    cargo(['build', '--release', '-p', 'llull-kernel'], { ...rustTarget, LLULL_OCCT_DIR: occtPrefix, LLULL_OCCT_RPATH_BUNDLE_ONLY: '1' });
  return { compute: path.join(cargoTarget, 'compute'), kernel: path.join(cargoTarget, 'release') };
}

/** The toolkit files the loader asks for by name (SONAME / install name / DLL), never the development symlinks. */
function occtRuntimeFiles(prefix) {
  const [major, minor] = occt.OCCT_VERSION.split('.');
  if (process.platform === 'win32') {
    const bin = path.join(prefix, 'bin');
    return readdirSync(bin)
      .filter((name) => name.toLowerCase().endsWith('.dll'))
      .map((name) => path.join(bin, name));
  }
  const pattern =
    process.platform === 'darwin'
      ? new RegExp(`^libTK\\w+\\.${major}\\.${minor}\\.dylib$`)
      : new RegExp(`^libTK\\w+\\.so\\.${major}\\.${minor}$`);
  const lib = path.join(prefix, 'lib');
  return readdirSync(lib)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(lib, name));
}

function stageOcct(prefix) {
  const files = occtRuntimeFiles(prefix);
  if (files.length === 0) throw new Error(`no OCCT runtime libraries in ${prefix}`);
  const target = process.platform === 'win32' ? nativeDir : path.join(nativeDir, 'occt', 'lib');
  mkdirSync(target, { recursive: true });
  for (const file of files) copyFileSync(file, path.join(target, path.basename(file)));
  return files.length;
}

function occtNotice(prefix) {
  const stamp = JSON.parse(readFileSync(path.join(prefix, 'llull-occt.json'), 'utf8'));
  return [
    `Open CASCADE Technology (OCCT) ${stamp.version}`,
    'Copyright (c) Open CASCADE SAS. Licensed under the GNU Lesser General Public License version 2.1 with the Open CASCADE',
    'Exception (LICENSE_LGPL_21.txt, OCCT_LGPL_EXCEPTION.txt).',
    '',
    'llull-kernel links OCCT DYNAMICALLY; the unmodified OCCT shared libraries are in occt/lib (Windows: the TK*.dll files next to',
    'llull-kernel.exe). You may replace them with your own build of the same OCCT version (same toolkit names and ABI).',
    '',
    `Corresponding source: ${stamp.source}`,
    `sha256 ${stamp.sha256} (the upstream V${stamp.version.replaceAll('.', '_')} tag, Debian dfsg repack).`,
    'Build recipe: solver/scripts/build-occt.mjs in the llull source tree (toolkits: ' + stamp.toolkits.join(', ') + ').',
    '',
  ].join('\n');
}

const FDLIBM_NOTICE = `llull-jsmath (inside llull-compute) transliterates V8's src/base/ieee754.cc, itself derived from fdlibm 5.3.

fdlibm:
Copyright (C) 1993-2004 by Sun Microsystems, Inc. All rights reserved.
Permission to use, copy, modify, and distribute this software is freely granted, provided that this notice is preserved.

V8 (BSD-3-Clause):
Copyright 2016 the V8 project authors. All rights reserved.
Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following
conditions are met: (1) Redistributions of source code must retain the above copyright notice, this list of conditions and the
following disclaimer. (2) Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the
following disclaimer in the documentation and/or other materials provided with the distribution. (3) Neither the name of Google Inc.
nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior
written permission.
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;

/** Every third-party crate linked into the bundled binaries (resolved graph for this platform and features) with its licence files. */
function rustLicences() {
  const host = /host: (\S+)/.exec(execFileSync('rustc', ['-vV']).toString())?.[1];
  const features = withGpu ? ['--features', 'llull-compute/gpu'] : [];
  const metadata = JSON.parse(
    execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', ...(host ? ['--filter-platform', host] : []), ...features], {
      cwd: solver,
      maxBuffer: 256 * 1024 * 1024,
    }).toString(),
  );
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const roots = metadata.packages.filter((pkg) => pkg.name === 'llull-compute' || (withKernel && pkg.name === 'llull-kernel'));
  const seen = new Set();
  const stack = roots.map((pkg) => pkg.id);
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    // Normal (runtime) dependencies only: build scripts and dev-dependencies are not shipped.
    for (const dep of nodes.get(id)?.deps ?? []) if (dep.dep_kinds.some((kind) => kind.kind === null)) stack.push(dep.pkg);
  }
  const workspace = new Set(metadata.workspace_members);
  const crates = [...seen]
    .filter((id) => !workspace.has(id))
    .map((id) => packages.get(id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const sections = crates.map((pkg) => {
    const dir = path.dirname(pkg.manifest_path);
    const files = readdirSync(dir).filter((name) => /^(licen[cs]e|copying|notice)/i.test(name) && statSync(path.join(dir, name)).isFile());
    const texts = files.map((name) => `--- ${name}\n${readFileSync(path.join(dir, name), 'utf8').trim()}\n`);
    return [
      `=== ${pkg.name} ${pkg.version} — ${pkg.license ?? pkg.license_file ?? 'unknown licence'}`,
      pkg.repository ?? '',
      ...texts,
    ].join('\n');
  });
  return {
    count: crates.length,
    text: `Third-party Rust crates linked into the llull native binaries (${crates.length}).\n\n${sections.join('\n\n')}\n`,
  };
}

function smokeTest() {
  const compute = execFileSync(path.join(nativeDir, `llull-compute${exe}`), ['--version'])
    .toString()
    .trim();
  log(compute);
  if (!withKernel) return { compute };
  const kernel = execFileSync(path.join(nativeDir, `llull-kernel${exe}`), ['--version'], { env: { ...process.env, LD_LIBRARY_PATH: '' } })
    .toString()
    .trim();
  log(kernel);
  if (!kernel.includes(`OCCT ${occt.OCCT_VERSION}`))
    throw new Error(`bundled llull-kernel reports "${kernel}", expected OCCT ${occt.OCCT_VERSION}`);
  return { compute, kernel };
}

function sizeOf(dir) {
  return readdirSync(dir).reduce((total, name) => {
    const file = path.join(dir, name);
    const stat = lstatSync(file);
    return total + (stat.isDirectory() ? sizeOf(file) : stat.size);
  }, 0);
}

const occtPrefix = withKernel ? await occt.buildOcct(occt.occtPrefix()) : null;
const source = binaries(occtPrefix);
rmSync(nativeDir, { recursive: true, force: true });
mkdirSync(path.join(nativeDir, 'licenses'), { recursive: true });
for (const binary of ['llull-compute', ...(withKernel ? ['llull-kernel'] : [])]) {
  const from = path.join(binary === 'llull-compute' ? source.compute : source.kernel, `${binary}${exe}`);
  if (!existsSync(from)) throw new Error(`${from} is missing`);
  cpSync(from, path.join(nativeDir, `${binary}${exe}`));
  if (process.platform !== 'win32') chmodSync(path.join(nativeDir, `${binary}${exe}`), 0o755);
}
let toolkits = 0;
if (occtPrefix !== null) {
  toolkits = stageOcct(occtPrefix);
  for (const notice of ['LICENSE_LGPL_21.txt', 'OCCT_LGPL_EXCEPTION.txt'])
    cpSync(path.join(occtPrefix, notice), path.join(nativeDir, 'licenses', `OCCT-${notice}`));
  writeFileSync(path.join(nativeDir, 'licenses', 'OCCT-NOTICE.txt'), occtNotice(occtPrefix));
}
writeFileSync(path.join(nativeDir, 'licenses', 'fdlibm-V8-NOTICE.txt'), FDLIBM_NOTICE);
const rust = rustLicences();
writeFileSync(path.join(nativeDir, 'licenses', 'THIRD-PARTY-RUST.txt'), rust.text);
const versions = smokeTest();
writeFileSync(
  path.join(nativeDir, 'LLULL_NATIVE.json'),
  `${JSON.stringify(
    {
      platform: `${process.platform}-${process.arch}`,
      ...versions,
      gpu: withGpu,
      occt:
        occtPrefix === null ? null : { version: occt.OCCT_VERSION, sha256: occt.SOURCE_SHA256, toolkits, linking: 'dynamic (LGPL-2.1)' },
      rustCrates: rust.count,
      prebuilt: Boolean(process.env.LLULL_NATIVE_PREBUILT_DIR),
    },
    null,
    2,
  )}\n`,
);
log(`staged ${nativeDir} (${(sizeOf(nativeDir) / 1024 / 1024).toFixed(1)} MB, ${toolkits} OCCT toolkits, ${rust.count} Rust crates)`);
