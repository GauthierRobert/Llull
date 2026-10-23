/**
 * Inject the configured geometry kernel into the core at startup (architecture L9) so boolean and
 * fillet commands work for the CLI exactly as in the desktop app. `LLULL_KERNEL` unset (or any value but `manifold`, e.g. the explicit
 * `occt-native`) installs the native `llull-kernel` sidecar (RS-1, KI7, LC1 step 1) when the binary is found (`native/nativeBinary.ts`),
 * else Manifold with a warning and `kernel_info.fallbackReason`. `LLULL_KERNEL=manifold` is a diagnostic override (Manifold, no warning).
 */

import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import type { KernelInfo } from '@core/geometry/kernelPorts';
import { composeMeshEngines, setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import type { MeshProcessingEngine } from '@core/geometry/mesh/engineTypes';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createManifoldMeshEngine } from '@kernel-manifold/manifoldMeshEngine';
import { errorMessage } from '@lib/errorMessage';
import { positiveInteger } from './env';
import { createNativeMeshEngine } from './native/meshProcessingEngine';
import { startNativeKernel } from './nativeKernel';

/** The installed kernel: `occt` is the native OCCT sidecar, `manifold` the in-process mesh kernel. */
type ActiveKernel = 'manifold' | 'occt';

let activeKernel: ActiveKernel | null = null;

/** Kernel actually installed, or null before/without one. */
export function getActiveKernelName(): ActiveKernel | null {
  return activeKernel;
}

let warned = false;

/** One stderr line per process: what is unavailable, why, and where to look (`llull status`); details are under LLULL_DEBUG. */
function warnUnavailable(label: string, error: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(`[llull] ${label}: ${errorMessage(error)} (details: llull status, LLULL_DEBUG=1)`);
}

/** One OCC call blocks the whole server (HTTP, SSE keepalives) while it runs, so it is bounded. */
const DEFAULT_OCC_CALL_TIMEOUT_MS = 30_000;

/** `LLULL_OCC_TIMEOUT_MS`: positive milliseconds a single OCC call may run before its worker is killed. */
export function occtCallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(env['LLULL_OCC_TIMEOUT_MS'], DEFAULT_OCC_CALL_TIMEOUT_MS);
}

/** `kernel` whose `info()` also tells how the server runs it (`kernel_info`, TR-KRN-04); every other member is the kernel's own. */
function described(kernel: GeometryKernel, extra: Pick<KernelInfo, 'isolation' | 'fallbackReason'>): GeometryKernel {
  return { ...kernel, info: () => ({ capabilities: [], ...kernel.info?.(), ...extra }) };
}

export interface KernelInstallOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Native sidecar start (tests inject the discovery and the process). */
  readonly startNative?: typeof startNativeKernel;
}

/**
 * The mesh engines of mesh modelling (07 MSH): the native `llull-compute meshops` (decimate / smooth at any size) when the binary is installed and
 * the Manifold engine (Minkowski, offset, hollow, wrap, mesh booleans), whichever B-rep kernel is installed. A missing engine only makes the ops it
 * serves refuse (MESH_ENGINE_UNSUPPORTED / MESH_ENGINE_CAP_EXCEEDED).
 */
async function installMeshEngine(env: NodeJS.ProcessEnv): Promise<void> {
  const engines: MeshProcessingEngine[] = [];
  const native = createNativeMeshEngine({ env });
  if (native !== null) engines.push(native);
  try {
    engines.push(await createManifoldMeshEngine());
  } catch (error) {
    warnUnavailable('Manifold mesh engine unavailable; Minkowski, offset, hollow, wrap and mesh booleans will refuse', error);
  }
  setMeshProcessingEngine(engines.length === 0 ? null : composeMeshEngines(engines));
}

/** Load the configured kernel; on failure commands keep their graceful "no kernel" no-op. */
export async function installGeometryKernel(options: KernelInstallOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const startNative = options.startNative ?? startNativeKernel;
  warned = false;
  await installMeshEngine(env);
  let fallbackReason: string | undefined;
  if (env['LLULL_KERNEL']?.trim().toLowerCase() !== 'manifold') {
    const native = startNative({ callTimeoutMs: occtCallTimeoutMs(env) }, env);
    if ('kernel' in native) {
      setGeometryKernel(described(native.kernel, { isolation: 'process' }));
      activeKernel = 'occt';
      return true;
    }
    fallbackReason = native.reason;
    warnUnavailable('native OCC kernel unavailable; using Manifold', native.reason);
  }
  try {
    setGeometryKernel(
      described(await createManifoldKernel(), { isolation: 'in-process', ...(fallbackReason === undefined ? {} : { fallbackReason }) }),
    );
    activeKernel = 'manifold';
    return true;
  } catch (error) {
    warnUnavailable('geometry kernel unavailable; boolean commands will no-op', error);
    return false;
  }
}
