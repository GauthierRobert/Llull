/** Kernel provenance and modelling tolerance of a document (aerospace 01 KRN, TR-KRN-11/61); `CadDocument.kernelSettings`. */
export interface DocumentKernelSettings {
  readonly kernel: 'occt' | 'manifold';
  /** e.g. "7.4.0p1"; stamped on save from the active kernel. */
  readonly occtVersion?: string;
  /** Binary identity of the kernel, e.g. "llull-kernel@0.1.0". */
  readonly build?: string;
  readonly modelingTolerance: {
    /** mm; default 1e-4; range [1e-7, 1e-2]. Heal / sew / import precision. */
    readonly linear: number;
    /** rad; default 1e-9. */
    readonly angular: number;
    /** mm; default 0.01. Sub-shape tolerances above it raise KRN_IMPORT_TOLERANCE_HIGH. */
    readonly maxImportTolerance: number;
  };
}
