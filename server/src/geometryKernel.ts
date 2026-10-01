/**
 * @layer server
 *
 * Inject the Manifold geometry kernel into the core at startup (architecture L9) so boolean
 * commands work for MCP agents exactly as in the browser app — including the booleans that
 * `import_code` replays from a CadQuery/build123d trace.
 */

import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@core/geometry/manifoldKernel';

/** Load the WASM kernel; on failure booleans keep their graceful "no kernel" no-op. */
export async function installGeometryKernel(): Promise<boolean> {
  try {
    setGeometryKernel(await createManifoldKernel());
    return true;
  } catch (error) {
    console.warn(
      '[server] geometry kernel unavailable; boolean commands will no-op:',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
