import type { RasterPort } from '../model/raster';

let installed: RasterPort | null = null;

/** Install (or with null, remove) the process native raster (`ctx.raster` of the default context). Composition roots / hosts only. */
export function setRasterPort(port: RasterPort | null): void {
  installed = port;
}

/** The installed native raster, or null (llull is fully usable without it: the TypeScript raster is the default). */
export function getRasterPort(): RasterPort | null {
  return installed;
}
