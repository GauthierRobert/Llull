/**
 * Bundle Python + CadQuery into build/python (shipped as resources/python): the backend's STEP
 * import/export and CadQuery code exchange (server/python/llull_bridge.py) need no system Python.
 *
 * Source: a relocatable python-build-standalone `install_only` build for this OS/arch, then
 * `pip install -r server/python/requirements.txt`, then a bridge probe that must report CadQuery.
 * Build each OS on that OS (pip installs that platform's wheels).
 *
 * Env:
 *   LLULL_PYTHON_STANDALONE_URL     override the archive URL (mirror, other version)
 *   LLULL_PYTHON_STANDALONE_SHA256  verify the archive (recommended in CI)
 *   LLULL_PYTHON_STANDALONE_DIR     use an already-extracted python-build-standalone tree instead
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '..');
const buildDir = path.join(desktop, 'build');
const pythonRoot = path.join(buildDir, 'python');

/** Pinned CPython (CadQuery/OCP ship wheels for it on every desktop platform). */
const RELEASE = '20250115';
const VERSION = '3.12.8';
const TRIPLES = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

function archiveUrl() {
  if (process.env.LLULL_PYTHON_STANDALONE_URL) return process.env.LLULL_PYTHON_STANDALONE_URL;
  const triple = TRIPLES[`${process.platform}-${process.arch}`];
  if (triple === undefined)
    throw new Error(`no bundled Python for ${process.platform}-${process.arch}`);
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/cpython-${VERSION}+${RELEASE}-${triple}-install_only.tar.gz`;
}

const interpreter = () =>
  process.platform === 'win32'
    ? path.join(pythonRoot, 'python.exe')
    : path.join(pythonRoot, 'bin', 'python3');

async function fetchPython() {
  rmSync(pythonRoot, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  const local = process.env.LLULL_PYTHON_STANDALONE_DIR;
  if (local) {
    cpSync(local, pythonRoot, { recursive: true, verbatimSymlinks: true });
    return;
  }
  const url = archiveUrl();
  console.warn(`[prepare-python] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const expected = process.env.LLULL_PYTHON_STANDALONE_SHA256;
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (expected && expected.toLowerCase() !== actual)
    throw new Error(`checksum mismatch: expected ${expected}, got ${actual}`);
  const archive = path.join(buildDir, 'python.tar.gz');
  writeFileSync(archive, bytes);
  // The archive's top-level directory is `python/`.
  execFileSync('tar', ['-xzf', archive, '-C', buildDir], { stdio: 'inherit' });
  rmSync(archive);
}

function pipInstall() {
  const requirements = path.join(repo, 'server', 'python', 'requirements.txt');
  execFileSync(
    interpreter(),
    // Wheels only: sdists make pip backtrack for many minutes and need a compiler toolchain.
    [
      '-m',
      'pip',
      'install',
      '--no-cache-dir',
      '--disable-pip-version-check',
      '--only-binary',
      ':all:',
      '-r',
      requirements,
    ],
    { stdio: 'inherit' },
  );
}

function probeBridge() {
  const bridge = path.join(repo, 'server', 'python', 'llull_bridge.py');
  const output = execFileSync(interpreter(), [bridge], { input: '{"op":"probe"}' }).toString();
  const probe = JSON.parse(output);
  if (probe.ok !== true || probe.cadquery === null)
    throw new Error(`bundled Python has no working CadQuery: ${output}`);
  console.warn(
    `[prepare-python] Python ${probe.python}, CadQuery ${probe.cadquery} ready in ${pythonRoot}`,
  );
}

await fetchPython();
if (!existsSync(interpreter())) throw new Error(`no interpreter at ${interpreter()}`);
pipInstall();
probeBridge();
writeFileSync(
  path.join(pythonRoot, 'LLULL_BUNDLE.txt'),
  `${readFileSync(path.join(repo, 'server', 'python', 'requirements.txt'), 'utf8')}`,
);
