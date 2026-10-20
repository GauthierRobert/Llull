/** Verification state of lamina data (06 CMP FR-CMP-68): `unverified` propagates to every result computed from the record. */

import type { LaminaMaterial } from '@core/model/composites';

/** A lamina record is unverified when its basis is a mean / unknown value or its source is not a citation. */
export const isUnverified = (material: LaminaMaterial): boolean =>
  material.basis === 'mean' || material.basis === 'unknown' || material.source.trim().length < 4;
