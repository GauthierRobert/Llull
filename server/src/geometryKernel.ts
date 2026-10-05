/**
 * @layer server
 *
 * Inject the configured geometry kernel into the core at startup (architecture L9) so boolean and
 * fillet commands work for MCP agents exactly as in the browser app. `LLULL_KERNEL=occt` selects
 * OpenCascade (falls back to Manifold on failure); anything else is Manifold.
 */

import { setGeometryKernel } from '@core/geometry/kernel';
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

/** Load the configured kernel; on failure commands keep their graceful "no kernel" no-op. */
export async function installGeometryKernel(): Promise<boolean> {
  if (parseKernelChoice(process.env['LLULL_KERNEL']) === 'occt') {
    try {
      const { createNodeOcctKernel } = await import('./occtNode');
      setGeometryKernel(await createNodeOcctKernel());
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
