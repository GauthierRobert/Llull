/**
 * Browser loader for the OCC kernel: supplies the WASM asset URL core must not know about.
 *
 * @layer ui/geometry
 */

import type { GeometryKernel } from '@core/geometry/kernel';
import { createOcctKernel } from '@core/geometry/occtKernel';
import wasmUrl from 'opencascade.js/dist/opencascade.wasm.wasm?url';

export function createBrowserOcctKernel(): Promise<GeometryKernel> {
  return createOcctKernel({ locateFile: (path) => (path.endsWith('.wasm') ? wasmUrl : path) });
}
