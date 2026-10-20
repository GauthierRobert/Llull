/** Availability probes for the external FE tools (Gmsh Python module, CalculiX) so the FE suites skip instead of failing without them. */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const PYTHON = process.env['LLULL_TEST_FEA_PYTHON'] ?? process.env['LLULL_PYTHON'] ?? 'python3';
export const BRIDGE = path.resolve(__dirname, '../python/llull_bridge.py');
const CCX = process.env['LLULL_CCX'] ?? 'ccx';

export const HAS_GMSH = spawnSync(PYTHON, ['-c', 'import gmsh, numpy'], { stdio: 'ignore' }).status === 0;
export const HAS_CCX = spawnSync(CCX, ['-v'], { stdio: 'ignore' }).error === undefined;

/**
 * The CLI `env` of the FE suites: the run uses the same interpreter and solver the probes above found (not a bare `python3` / `ccx`), and the
 * search path the probe saw (a Windows ccx loads its DLLs from PATH).
 */
export const FEA_TOOL_ENV: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => /^(path|systemroot)$/i.test(entry[0]) && entry[1] !== undefined,
    ),
  ),
  LLULL_GMSH_PYTHON: PYTHON,
  LLULL_CCX: CCX,
};
