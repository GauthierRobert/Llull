/**
 * @layer server/tests
 *
 * Shared helpers for the Python-bridge test suites: detect a CadQuery / build123d python once.
 * Not a test file (no `.test.ts` suffix).
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const BRIDGE_SCRIPT = path.resolve(__dirname, '../python/llull_bridge.py');
const configuredPython =
  process.env['LLULL_TEST_CADQUERY_PYTHON'] ?? process.env['LLULL_PYTHON'] ?? 'python3';
export const CADQUERY_PYTHON =
  configuredPython === 'off' ? '/nonexistent/python' : configuredPython;
export const BUILD123D_PYTHON = process.env['LLULL_TEST_BUILD123D_PYTHON'];

export interface ProbeResult {
  readonly cadquery: string | null;
  readonly build123d: string | null;
}

/** Ask the bridge which CAD libraries `python` has (synchronously, for describe.skipIf); never throws. */
export function probePython(python: string): ProbeResult {
  const none: ProbeResult = { cadquery: null, build123d: null };
  const run = spawnSync(python, [BRIDGE_SCRIPT], {
    input: JSON.stringify({ op: 'probe' }),
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (run.error !== undefined || run.status !== 0) return none;
  try {
    const response = JSON.parse(run.stdout) as Record<string, unknown>;
    return {
      cadquery: typeof response['cadquery'] === 'string' ? response['cadquery'] : null,
      build123d: typeof response['build123d'] === 'string' ? response['build123d'] : null,
    };
  } catch {
    return none;
  }
}
