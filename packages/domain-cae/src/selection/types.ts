/** Result shapes of the material-selection commands (PHY-12 TECHNICAL_SPEC §3.2). */

export const INDEX_CASES = [
  'tie_stiffness',
  'tie_strength',
  'beam_stiffness',
  'beam_strength',
  'panel_stiffness',
  'panel_strength',
  'column_buckling',
] as const;

export type IndexCase = (typeof INDEX_CASES)[number];

export type StrengthProperty = 'Fty' | 'Ftu' | 'Fcy';

export interface SelIssue {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly ids: readonly string[];
  readonly remediation: string;
}

export interface Quantity {
  readonly value: number;
  readonly unit: string;
}

/** One material value as a selection read it, converted to the base unit of its index. */
export interface PropertyUse {
  readonly property: string;
  readonly value: number;
  readonly unit: string;
  readonly basis: string;
  readonly propertyValueId: string;
  readonly provenance: string;
  readonly direction?: string;
  readonly temperature?: Quantity;
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
}

export interface IndexResult {
  readonly material: string;
  readonly case: IndexCase;
  readonly value: number;
  readonly unit: string;
  readonly inputs: readonly PropertyUse[];
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  readonly warnings: readonly SelIssue[];
  readonly provenance: { readonly rule: string; readonly derivation: string };
}

/** A candidate left out of a ranking: never ranked on a guess. */
export interface Excluded {
  readonly material: string;
  readonly code: string;
  readonly reason: string;
  readonly missing?: readonly string[];
}
