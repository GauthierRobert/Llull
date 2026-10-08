/**
 * @layer server
 *
 * Inject the configured geometry kernel into the core at startup (architecture L9) so boolean and
 * fillet commands work for MCP agents exactly as in the browser app. `LLULL_KERNEL=occt` selects
 * OpenCascade (falls back to Manifold on failure); anything else is Manifold.
 */

import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { createIsolatedKernel, defaultWorkerEntry } from './isolatedKernel';
import { parseKernelChoice, type KernelChoice } from '@core/geometry/kernelChoice';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { errorMessage } from '@lib/errorMessage';

let activeKernel: KernelChoice | null = null;

/** Kernel actually installed, or null before/without one. */
export function getActiveKernelName(): KernelChoice | null {
  return activeKernel;
}

function warnUnavailable(label: string, error: unknown): void {
  console.warn(`[server] ${label}:`, errorMessage(error));
}

/** One OCC call blocks the whole server (HTTP, SSE keepalives) while it runs, so it is bounded. */
const DEFAULT_OCC_CALL_TIMEOUT_MS = 30_000;

/** `LLULL_OCC_TIMEOUT_MS`: positive milliseconds a single OCC call may run before its worker is killed. */
export function occtCallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const requested = Number(env['LLULL_OCC_TIMEOUT_MS']);
  return Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_OCC_CALL_TIMEOUT_MS;
}

/**
 * OCC in a worker thread, so a WASM abort kills the worker, not the server. Null (in-process OCC is
 * used instead, with a warning) when `LLULL_OCC_ISOLATION=off`, when the worker entry is not
 * shipped (`npm run build` emits dist/occtWorker.js) or when the worker cannot start.
 */
function startIsolatedOcct(): GeometryKernel | null {
  if (process.env['LLULL_OCC_ISOLATION'] === 'off' || defaultWorkerEntry() === null) return null;
  const isolated = createIsolatedKernel({ callTimeoutMs: occtCallTimeoutMs() });
  if (isolated.start()) return isolated;
  isolated.dispose();
  warnUnavailable(
    'OCC worker unavailable; running OCC in-process',
    'a WASM abort would stop the server',
  );
  return null;
}

/** Load the configured kernel; on failure commands keep their graceful "no kernel" no-op. */
export async function installGeometryKernel(): Promise<boolean> {
  if (parseKernelChoice(process.env['LLULL_KERNEL']) === 'occt') {
    try {
      const { createNodeOcctKernel } = await import('./occtNode');
      setGeometryKernel(startIsolatedOcct() ?? (await createNodeOcctKernel()));
      activeKernel = 'occt';
      return true;
    } catch (error) {
      warnUnavailable('OCC kernel unavailable; falling back to Manifold', error);
    }
  }
  try {
    setGeometryKernel(await createManifoldKernel());
    activeKernel = 'manifold';
    return true;
  } catch (error) {
    warnUnavailable('geometry kernel unavailable; boolean commands will no-op', error);
    return false;
  }
}
