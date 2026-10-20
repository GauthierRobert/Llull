/** Verification state of lamina data (06 CMP FR-CMP-68): `unverified` propagates to every result computed from the record. */

/** The provenance fields of a lamina record. */
export interface LaminaProvenance {
  readonly basis: 'mean' | 'b_basis' | 'a_basis' | 'unknown';
  readonly source: string;
}

/** A lamina record is unverified when its basis is a mean / unknown value or its source is not a citation. */
export const isUnverified = (material: LaminaProvenance): boolean =>
  material.basis === 'mean' || material.basis === 'unknown' || material.source.trim().length < 4;
