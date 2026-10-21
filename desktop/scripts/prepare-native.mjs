/**
 * Bundle the native binaries (docs/decisions/RS1-native-compute.md) into build/native (shipped as resources/native; the desktop
 * backend gets LLULL_NATIVE_DIR only when it exists):
 *
 *   build/native/llull-compute[.exe]   jobs (fatigue/map post-processing, field raster, topology optimisation `topopt`) — built WITH the
 *                                      `gpu` feature: raster and topopt use wgpu when an adapter exists and fall back to the bit-exact
 *                                      CPU twin otherwise (topology_solve device cpu is the default)
 *   build/native/llull-kernel[.exe]    native OCCT kernel sidecar (the exact kernel: LLULL_KERNEL=occt-native is the desktop default, KI7)
 *   build/native/llull-mesh[.exe]      FE mesher sidecar (fea_mesh): Gmsh through its C API, loaded at run time from
 *   build/native/gmsh/lib/             the shared Gmsh library (GPL-2.0-or-later, its own OpenCASCADE inside; Windows: the DLL sits next to
 *                                      the executables instead), taken from LLULL_GMSH_LIB or the `pip install gmsh` of the build Python
 *   build/native/occt/lib/             shared OCCT toolkits, LGPL-2.1 dynamic linking (Linux .so.<maj>.<min>, macOS .<maj>.<min>.dylib;
 *                                      Windows: the DLLs sit next to the executables instead, where the loader looks)
 *   build/native/licenses/             OCCT LGPL-2.1 + exception + source/relink notice, Gmsh licence + credits + source notice,
 *                                      fdlibm/V8 notice, Rust crate licences
 *   build/native/LLULL_NATIVE.json     what was bundled (versions, features, OCCT source sha256)
 *
 * Build each OS on that OS. Env:
 *   LLULL_NATIVE_PREBUILT_DIR   take llull-compute / llull-kernel (/ llull-mesh, bundled only when present) from this directory instead of
 *                               building them with cargo
 *   LLULL_NATIVE_GPU=0          build llull-compute without the `gpu` feature (CPU twin only)
 *   LLULL_NATIVE_KERNEL=0       bundle llull-compute only (no llull-kernel, no OCCT)
 *   LLULL_OCCT_DIR              OCCT install prefix (else solver/scripts/build-occt.mjs builds or reuses its default prefix)
 *   LLULL_NATIVE_MESH=0         bundle no llull-mesh / Gmsh (fea_mesh then needs the Python bridge with gmsh, LLULL_MESHER=python)
 *   LLULL_GMSH_LIB              the Gmsh shared library to bundle (else asked from LLULL_GMSH_PYTHON / python3: `gmsh.libpath`)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  realpathSync,
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
const prebuiltDir = process.env.LLULL_NATIVE_PREBUILT_DIR;
/** A prebuilt folder without llull-mesh bundles no mesher (older prebuilt flows keep working). */
const withMesh = process.env.LLULL_NATIVE_MESH !== '0' && (!prebuiltDir || existsSync(path.join(prebuiltDir, `llull-mesh${exe}`)));

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
  const prebuilt = prebuiltDir;
  if (prebuilt) return { compute: prebuilt, kernel: prebuilt, mesh: prebuilt };
  const rustTarget = { CARGO_TARGET_DIR: cargoTarget };
  cargo(['build', '--profile', 'compute', '-p', 'llull-compute', ...(withGpu ? ['--features', 'gpu'] : [])], rustTarget);
  if (withKernel)
    cargo(['build', '--release', '-p', 'llull-kernel'], { ...rustTarget, LLULL_OCCT_DIR: occtPrefix, LLULL_OCCT_RPATH_BUNDLE_ONLY: '1' });
  if (withMesh) cargo(['build', '--release', '-p', 'llull-mesh'], rustTarget);
  return { compute: path.join(cargoTarget, 'compute'), kernel: path.join(cargoTarget, 'release'), mesh: path.join(cargoTarget, 'release') };
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

/** The Gmsh shared library to bundle: LLULL_GMSH_LIB, else the one the build Python's `gmsh` module loads (`pip install gmsh`). */
function gmshLibrary() {
  const configured = process.env.LLULL_GMSH_LIB;
  if (configured) {
    if (!existsSync(configured)) throw new Error(`LLULL_GMSH_LIB=${configured} does not exist`);
    return path.resolve(configured);
  }
  const python = process.env.LLULL_GMSH_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const probe = spawnSync(python, ['-c', 'import gmsh; print(gmsh.libpath or "")'], { encoding: 'utf8' });
  const library = probe.status === 0 ? probe.stdout.trim() : '';
  if (library === '' || !existsSync(library))
    throw new Error(
      `no Gmsh library to bundle: set LLULL_GMSH_LIB, or \`pip install gmsh\` for ${python} (LLULL_GMSH_PYTHON), or LLULL_NATIVE_MESH=0. ${probe.stderr ?? ''}`,
    );
  return library;
}

/** The Gmsh licence files shipped with the SDK / wheel (`<prefix>/share/doc/gmsh` next to `<prefix>/lib`), when present. */
function gmshLicenceFiles(library) {
  const prefix = path.dirname(path.dirname(library));
  const candidates = [path.join(prefix, 'share', 'doc', 'gmsh'), path.join(prefix, 'doc'), prefix, path.dirname(library)];
  for (const dir of candidates) {
    const files = ['LICENSE.txt', 'CREDITS.txt'].map((name) => path.join(dir, name));
    if (existsSync(files[0])) return files.filter((file) => existsSync(file));
  }
  return [];
}

function gmshTargetDir() {
  return process.platform === 'win32' ? nativeDir : path.join(nativeDir, 'gmsh', 'lib');
}

/** Linux: the system libraries libgmsh needs that this machine lacks (the bundle ships libgmsh only). */
function gmshMissingDependencies(library) {
  if (process.platform !== 'linux') return [];
  const ldd = spawnSync('ldd', [library], { encoding: 'utf8' });
  return (ldd.stdout ?? '')
    .split('\n')
    .filter((line) => line.includes('not found'))
    .map((line) => line.trim());
}

function stageGmsh(library) {
  const target = gmshTargetDir();
  mkdirSync(target, { recursive: true });
  copyFileSync(library, path.join(target, path.basename(library)));
  const missing = gmshMissingDependencies(library);
  if (missing.length > 0) throw new Error(`libgmsh needs system libraries this machine lacks: ${missing.join('; ')}`);
  const licences = gmshLicenceFiles(library);
  if (licences.length === 0) log(`WARNING: no Gmsh LICENSE.txt found near ${library}; only the notice is bundled`);
  for (const file of licences) copyFileSync(file, path.join(nativeDir, 'licenses', `Gmsh-${path.basename(file)}`));
  return path.basename(library);
}

function gmshNotice(version) {
  return [
    `Gmsh ${version}`,
    'Copyright (C) 1997-2026 C. Geuzaine, J.-F. Remacle. Licensed under the GNU General Public License version 2 or later, with the',
    'exceptions listed in Gmsh-LICENSE.txt; Gmsh-CREDITS.txt names the contributed code it includes (OpenCASCADE among it).',
    '',
    'llull-mesh is a separate executable that loads the unmodified Gmsh shared library (gmsh/lib, Windows: next to llull-mesh.exe)',
    'at run time through the Gmsh C API. You may replace that library with your own build of Gmsh 4.x (same C API).',
    '',
    `Corresponding source: https://gmsh.info/src/gmsh-${version}-source.tgz (the binary is the upstream Gmsh SDK / PyPI wheel).`,
    'The llull-mesh source is in the llull source tree (solver/bins/llull-mesh, solver/crates/llull-gmsh).',
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
  const roots = metadata.packages.filter(
    (pkg) => pkg.name === 'llull-compute' || (withKernel && pkg.name === 'llull-kernel') || (withMesh && pkg.name === 'llull-mesh'),
  );
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
  const versions = { compute };
  if (withKernel) {
    const kernel = execFileSync(path.join(nativeDir, `llull-kernel${exe}`), ['--version'], { env: { ...process.env, LD_LIBRARY_PATH: '' } })
      .toString()
      .trim();
    log(kernel);
    if (!kernel.includes(`OCCT ${occt.OCCT_VERSION}`))
      throw new Error(`bundled llull-kernel reports "${kernel}", expected OCCT ${occt.OCCT_VERSION}`);
    versions.kernel = kernel;
  }
  if (withMesh) {
    const env = { ...process.env, LD_LIBRARY_PATH: '' };
    delete env.LLULL_GMSH_LIB;
    const mesh = execFileSync(path.join(nativeDir, `llull-mesh${exe}`), ['--version'], { env })
      .toString()
      .trim();
    log(mesh);
    // the bundled library, not one found on the build machine's search path
    const library = /\(Gmsh \S+, (.*)\)$/.exec(mesh)?.[1];
    if (library === undefined || !existsSync(library) || realpathSync(path.dirname(library)) !== realpathSync(gmshTargetDir()))
      throw new Error(`bundled llull-mesh reports "${mesh}", expected the bundled Gmsh`);
    versions.mesh = mesh;
  }
  return versions;
}

function sizeOf(dir) {
  return readdirSync(dir).reduce((total, name) => {
    const file = path.join(dir, name);
    const stat = lstatSync(file);
    return total + (stat.isDirectory() ? sizeOf(file) : stat.size);
  }, 0);
}

// fail before building anything when there is no Gmsh to bundle
const gmshSource = withMesh ? gmshLibrary() : null;
const occtPrefix = withKernel ? await occt.buildOcct(occt.occtPrefix()) : null;
const source = binaries(occtPrefix);
rmSync(nativeDir, { recursive: true, force: true });
mkdirSync(path.join(nativeDir, 'licenses'), { recursive: true });
const sourceDir = { 'llull-compute': source.compute, 'llull-kernel': source.kernel, 'llull-mesh': source.mesh };
for (const binary of ['llull-compute', ...(withKernel ? ['llull-kernel'] : []), ...(withMesh ? ['llull-mesh'] : [])]) {
  const from = path.join(sourceDir[binary], `${binary}${exe}`);
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
const gmshFile = gmshSource === null ? null : stageGmsh(gmshSource);
writeFileSync(path.join(nativeDir, 'licenses', 'fdlibm-V8-NOTICE.txt'), FDLIBM_NOTICE);
const rust = rustLicences();
writeFileSync(path.join(nativeDir, 'licenses', 'THIRD-PARTY-RUST.txt'), rust.text);
const versions = smokeTest();
const gmshVersion = withMesh ? (/\(Gmsh (\S+),/.exec(versions.mesh)?.[1] ?? 'unknown') : null;
if (gmshVersion !== null) writeFileSync(path.join(nativeDir, 'licenses', 'Gmsh-NOTICE.txt'), gmshNotice(gmshVersion));
writeFileSync(
  path.join(nativeDir, 'LLULL_NATIVE.json'),
  `${JSON.stringify(
    {
      platform: `${process.platform}-${process.arch}`,
      ...versions,
      gpu: withGpu,
      occt:
        occtPrefix === null ? null : { version: occt.OCCT_VERSION, sha256: occt.SOURCE_SHA256, toolkits, linking: 'dynamic (LGPL-2.1)' },
      gmsh:
        gmshVersion === null
          ? null
          : { version: gmshVersion, library: gmshFile, linking: 'loaded at run time by llull-mesh (GPL-2.0-or-later)' },
      rustCrates: rust.count,
      prebuilt: Boolean(process.env.LLULL_NATIVE_PREBUILT_DIR),
    },
    null,
    2,
  )}\n`,
);
log(
  `staged ${nativeDir} (${(sizeOf(nativeDir) / 1024 / 1024).toFixed(1)} MB, ${toolkits} OCCT toolkits, ` +
    `${gmshVersion === null ? 'no Gmsh' : `Gmsh ${gmshVersion}`}, ${rust.count} Rust crates)`,
);
