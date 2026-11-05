/**
 * Availability probes for the external FE tools (the Netgen mesher llull-mesh, CalculiX) so the FE suites skip instead of failing without them.
 */

import { spawnSync } from 'node:child_process';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { requireTools, type ToolId } from '../../tests/requireTool';

const CCX = process.env['LLULL_CCX'] ?? 'ccx';

/** The built llull-mesh, or null. */
export const MESH_BIN = nativeBinaryPath('llull-mesh');
/** llull-mesh is built and runs (its Netgen / OCCT libraries load). */
export const HAS_MESHER = MESH_BIN !== null && /\(Netgen /.test(spawnSync(MESH_BIN, ['--version'], { encoding: 'utf8' }).stdout ?? '');
export const HAS_CCX = spawnSync(CCX, ['-v'], { stdio: 'ignore' }).error === undefined;

/** True (and recorded per missing tool) when the FE suites cannot run: llull-mesh, CalculiX and, with `kernel`, the native llull-kernel. */
export function feaToolsMissing(kernel = false): boolean {
  const tools: Array<readonly [ToolId, boolean]> = [
    ['native:llull-mesh', HAS_MESHER],
    ['calculix', HAS_CCX],
  ];
  if (kernel) tools.push(['native:llull-kernel', nativeBinaryPath('llull-kernel') !== null]);
  return requireTools(tools);
}

/**
 * The CLI `env` of the FE suites: the run uses the same mesher and solver the probes above found (not a bare `ccx`), and the
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
    Object.entries(process.env).filter((entry): entry is [string, string] => /^LLULL_MESH_BIN$/.test(entry[0]) && entry[1] !== undefined),
  ),
  LLULL_CCX: CCX,
};
