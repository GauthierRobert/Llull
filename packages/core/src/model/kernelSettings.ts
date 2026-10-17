/**
 * Kernel provenance and modelling tolerance of a document (aerospace 01 KRN, TR-KRN-11/61/102).
 * @invariant defaults are the TR-KRN-11 values: linear 1e-4 mm, angular 1e-9 rad, maxImportTolerance 0.01 mm
 */

import type { CadDocument, DocumentKernelSettings } from './types';

export type ModelingTolerance = DocumentKernelSettings['modelingTolerance'];

export const DEFAULT_MODELING_TOLERANCE: ModelingTolerance = { linear: 1e-4, angular: 1e-9, maxImportTolerance: 0.01 };

/** Policy range of `modelingTolerance.linear` in mm (TR-KRN-11); KRN_TOLERANCE_OUT_OF_RANGE outside it. */
export const LINEAR_TOLERANCE_RANGE_MM: readonly [number, number] = [1e-7, 1e-2];

/** Which kernel wrote or reads a document: `occtVersion` / `build` only for the exact kernel. */
export interface KernelStamp {
  readonly kernel: 'occt' | 'manifold';
  readonly occtVersion?: string;
  readonly build?: string;
}

export function modelingToleranceOf(doc: Pick<CadDocument, 'kernelSettings'>): ModelingTolerance {
  return doc.kernelSettings?.modelingTolerance ?? DEFAULT_MODELING_TOLERANCE;
}

/** `doc` with its provenance replaced by `stamp`; tolerances are kept (defaults when the document had no settings). */
export function withKernelStamp<D extends Pick<CadDocument, 'kernelSettings'>>(doc: D, stamp: KernelStamp): D {
  const exact = stamp.kernel === 'occt';
  const kernelSettings: DocumentKernelSettings = {
    kernel: stamp.kernel,
    ...(exact && stamp.occtVersion !== undefined ? { occtVersion: stamp.occtVersion } : {}),
    ...(exact && stamp.build !== undefined ? { build: stamp.build } : {}),
    modelingTolerance: modelingToleranceOf(doc),
  };
  return { ...doc, kernelSettings };
}
