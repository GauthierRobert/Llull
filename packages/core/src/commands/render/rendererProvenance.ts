/**
 * Which renderer drew a picture (plant 09 TR-VIS-30 / 34, RS1 §2 rule 3). The reference TypeScript raster is deterministic per
 * `rendererVersion` and is the only one that yields `svgSha256`; the native raster (`ctx.raster`) is a picture: no digest,
 * `deterministic: false`, its device and binary version. There is no silent fallback: a failed native frame fails the command.
 */

import type { RasterPort, RasterScene } from '../../model/raster';
import { sha256Hex } from '../../lib/sha256';
import type { PixelStage } from './types';

/** Bump when the reference raster's pixels change for the same inputs (pins `svgSha256` goldens, Q6). */
export const REFERENCE_RENDERER_VERSION = 'llull-ts-raster/1';

export interface NativeProvenance {
  readonly renderer: 'native';
  readonly engine: 'native-gpu' | 'native-cpu';
  readonly device: string;
  readonly deterministic: false;
  readonly version: string;
  readonly reason?: string;
}

export interface NativeRun {
  /** Pixel stage handing every frame to the port (a failed frame is left blank and recorded). */
  readonly pixels: PixelStage;
  /** Provenance of the frames drawn so far, or the first failure. */
  readonly result: () => NativeProvenance | { readonly code: string; readonly message: string };
}

/** A pixel stage drawing on `port` with `engine`. */
export function nativeRun(port: RasterPort, engine: 'gpu' | 'cpu'): NativeRun {
  let failure: { code: string; message: string } | null = null;
  let provenance: NativeProvenance | null = null;
  const pixels = (scene: RasterScene): Uint8Array => {
    const blank = new Uint8Array(scene.width * scene.height * 4);
    if (failure !== null) return blank;
    const outcome = port.render(scene, engine);
    if (!outcome.ok) {
      failure = { code: outcome.code, message: outcome.message };
      return blank;
    }
    const { image } = outcome;
    if (image.rgba.length !== blank.length) {
      failure = { code: 'NATIVE_JOB_FAILED', message: `the native raster returned ${image.rgba.length} bytes for ${blank.length}` };
      return blank;
    }
    provenance = {
      renderer: 'native',
      engine: image.engine,
      device: image.device,
      deterministic: false,
      version: image.version,
      ...(image.reason !== undefined ? { reason: image.reason } : {}),
    };
    return image.rgba;
  };
  return {
    pixels,
    result: () =>
      failure ??
      provenance ?? {
        code: 'NATIVE_JOB_FAILED',
        message: 'nothing to rasterise natively (no solid or sketch in view): use the reference renderer',
      },
  };
}

/** `data` fields of a reference render: its digest and renderer version. */
export function referenceProvenance(svg: string): { renderer: 'reference'; rendererVersion: string; svgSha256: string } {
  return { renderer: 'reference', rendererVersion: REFERENCE_RENDERER_VERSION, svgSha256: sha256Hex(svg) };
}
