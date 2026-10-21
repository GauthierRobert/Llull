/**
 * Availability probes for the external FE tools (Gmsh through llull-mesh or the Python module, CalculiX) so the FE suites skip instead of
 * failing without them. The suites mesh with whatever the server picks (nativeMesher.ts: llull-mesh when built, LLULL_MESHER=python forces
 * the bridge).
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { chooseMesher } from '../src/fea/nativeMesher';
import { nativeBinaryPath } from '../src/native/nativeBinary';

export const PYTHON = process.env['LLULL_TEST_FEA_PYTHON'] ?? process.env['LLULL_PYTHON'] ?? 'python3';
export const BRIDGE = path.resolve(__dirname, '../python/llull_bridge.py');
const CCX = process.env['LLULL_CCX'] ?? 'ccx';

/** The built llull-mesh, or null. */
export const MESH_BIN = nativeBinaryPath('llull-mesh');
const MESHER = chooseMesher(process.env);
export const HAS_GMSH =
  MESHER.kind === 'native'
    ? /\(Gmsh /.test(spawnSync(MESHER.binary, ['--version'], { encoding: 'utf8' }).stdout ?? '')
    : spawnSync(PYTHON, ['-c', 'import gmsh, numpy'], { stdio: 'ignore' }).status === 0;
export const HAS_CCX = spawnSync(CCX, ['-v'], { stdio: 'ignore' }).error === undefined;

/**
 * The CLI `env` of the FE suites: the run uses the same interpreter and solver the probes above found (not a bare `python3` / `ccx`), and the
 * search path the probe saw (a Windows ccx loads its DLLs from PATH).
 */
export const FEA_TOOL_ENV: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        /^(path|systemroot|ld_library_path|dyld_library_path)$/i.test(entry[0]) && entry[1] !== undefined,
    ),
  ),
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => /^LLULL_(MESHER|MESH_BIN|GMSH_LIB)$/.test(entry[0]) && entry[1] !== undefined,
    ),
  ),
  LLULL_GMSH_PYTHON: PYTHON,
  LLULL_CCX: CCX,
};
