/**
 * Bridges a live `GeometryKernel` to document provenance (TR-KRN-61): the stamp a save writes and the mismatch a load / `kernel_info` reports.
 * @invariant a kernel without `info()` has no stamp (nothing to compare), so documents saved without an exact kernel stay unstamped
 */

import type { GeometryKernel } from '../../geometry/kernel';
import type { CadDocument } from '../../model/types';
import type { KernelStamp } from '../../model/kernelSettings';

export function kernelStampOf(kernel: GeometryKernel | null): KernelStamp | null {
  const info = kernel?.info?.();
  if (kernel === null || info === undefined) return null;
  const exact = kernel.name === 'occt' || info.occtVersion !== undefined;
  return {
    kernel: exact ? 'occt' : 'manifold',
    ...(info.occtVersion === undefined ? {} : { occtVersion: info.occtVersion }),
    ...(info.build === undefined ? {} : { build: info.build }),
  };
}

/** KRN_KERNEL_MISMATCH text when the document was written by another kernel or OCCT version than `active`, else null. */
export function kernelMismatch(doc: Pick<CadDocument, 'kernelSettings'>, active: KernelStamp | null): string | null {
  const stored = doc.kernelSettings;
  if (stored === undefined || active === null) return null;
  if (stored.kernel !== active.kernel) return `document written by kernel '${stored.kernel}', active kernel is '${active.kernel}'`;
  if (stored.occtVersion !== undefined && active.occtVersion !== undefined && stored.occtVersion !== active.occtVersion)
    return `document written with OCCT ${stored.occtVersion}, active OCCT is ${active.occtVersion}`;
  return null;
}
