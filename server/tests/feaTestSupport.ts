/** Availability probes for the external FE tools (Gmsh Python module, CalculiX) so the FE suites skip instead of failing without them. */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const PYTHON = process.env['LLULL_TEST_FEA_PYTHON'] ?? process.env['LLULL_PYTHON'] ?? 'python3';
export const BRIDGE = path.resolve(__dirname, '../python/llull_bridge.py');

export const HAS_GMSH = spawnSync(PYTHON, ['-c', 'import gmsh, numpy'], { stdio: 'ignore' }).status === 0;
export const HAS_CCX = spawnSync(process.env['LLULL_CCX'] ?? 'ccx', ['-v'], { stdio: 'ignore' }).error === undefined;
