/**
 * The FE mesher behind `fea_mesh`: the native `llull-mesh` sidecar (solver/bins/llull-mesh, Gmsh through its C API). One JSON request on
 * stdin, one JSON response line on stdout (documented in solver/bins/llull-mesh/src/main.rs).
 * Environment: LLULL_MESH_BIN / LLULL_NATIVE_DIR (binary, nativeBinary.ts), LLULL_GMSH_LIB (the Gmsh shared library, read by llull-mesh).
 */

import { runProcess } from '../processRunner';
import type { MesherResponse } from './feaMesh';

const MAX_STDERR_BYTES = 64 * 1024;
/** Below V8's longest string (2^29 - 24 UTF-16 units), so the response still decodes. */
const MAX_OUTPUT_BYTES = 500 * 1024 * 1024;

/** The response line of llull-mesh: the last non-empty line of its stdout (anything Gmsh printed before it is ignored). */
export function parseMesherOutput(stdout: string): MesherResponse | null {
  const line = stdout
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .at(-1);
  if (line === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null && typeof (parsed as { ok?: unknown }).ok === 'boolean'
      ? (parsed as MesherResponse)
      : null;
  } catch {
    return null;
  }
}

/** One mesh request through `llull-mesh`; rejects when the process cannot run or answers nothing. */
export async function callNativeMesher(
  binary: string,
  request: Record<string, unknown>,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<MesherResponse> {
  const stdout: Buffer[] = [];
  let size = 0;
  const run = await runProcess({
    executable: binary,
    args: [],
    env,
    timeoutMs,
    input: JSON.stringify(request),
    tailBytes: MAX_STDERR_BYTES,
    onStdout: (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) return false;
      stdout.push(chunk);
    },
  });
  if (run.startError !== undefined) throw new Error(`cannot start llull-mesh "${binary}": ${run.startError}; FEA_TOOL_MISSING`);
  if (run.timedOut) throw new Error(`llull-mesh timed out after ${timeoutMs} ms`);
  if (run.aborted) throw new Error(`llull-mesh output exceeded ${MAX_OUTPUT_BYTES / 1024 / 1024} MB`);
  const response = parseMesherOutput(Buffer.concat(stdout).toString('utf8'));
  if (response === null)
    throw new Error(`llull-mesh exited with code ${String(run.exitCode)} without a response. ${run.stderr.trim().slice(-2000)}`);
  return response;
}
