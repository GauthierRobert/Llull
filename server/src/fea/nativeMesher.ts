/**
 * The FE mesher behind `fea_mesh`: the native `llull-mesh` sidecar (solver/bins/llull-mesh, Gmsh through its C API) when it is built or
 * bundled, else the Python bridge op `mesh` (server/python/llull_mesh.py). Both take the same request and answer the same response.
 * Environment: LLULL_MESHER = native | python (default: native when `llull-mesh` is found), LLULL_MESH_BIN / LLULL_NATIVE_DIR (binary),
 * LLULL_GMSH_LIB (the Gmsh shared library, read by llull-mesh).
 */

import { runProcess } from '../processRunner';
import { nativeBinaryPath } from '../native/nativeBinary';
import type { MeshBridgeResponse } from './feaMesh';

const MAX_STDERR_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

export type MesherChoice = { readonly kind: 'native'; readonly binary: string } | { readonly kind: 'python' };

/** `LLULL_MESHER=python` forces the bridge; `native` (or unset) takes `llull-mesh` when found, else the bridge. */
export function chooseMesher(
  env: NodeJS.ProcessEnv,
  find: (env: NodeJS.ProcessEnv) => string | null = (e) => nativeBinaryPath('llull-mesh', e),
): MesherChoice {
  if (env['LLULL_MESHER'] === 'python') return { kind: 'python' };
  const binary = find(env);
  return binary === null ? { kind: 'python' } : { kind: 'native', binary };
}

/** The response line of llull-mesh: the last non-empty line of its stdout (anything Gmsh printed before it is ignored). */
export function parseMesherOutput(stdout: string): MeshBridgeResponse | null {
  const line = stdout
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .at(-1);
  if (line === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null && typeof (parsed as { ok?: unknown }).ok === 'boolean'
      ? (parsed as MeshBridgeResponse)
      : null;
  } catch {
    return null;
  }
}

/** One mesh request through `llull-mesh`; rejects (like the bridge) when the process cannot run or answers nothing. */
export async function callNativeMesher(
  binary: string,
  request: Record<string, unknown>,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<MeshBridgeResponse> {
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
