/** Basis propagation of a joint capacity (08 MAT TECHNICAL_SPEC §5.6): bases are not a total order and a result basis is never upgraded. */

import type { Basis } from '@core/model/propertyModel';

export interface BasisInput {
  readonly role: string;
  readonly basis: Basis;
}

type JointBasis = 'A' | 'B' | 'mixed' | Exclude<Basis, 'A' | 'B'>;

/**
 * A only if every input is A; B if every input is in {A, B}; the shared basis when all inputs agree on a basis outside {A, B}
 * (S, typical, …); otherwise `mixed` (the caller lists the per-input bases). No inputs is `mixed`.
 */
export function propagateBasis(inputs: readonly BasisInput[]): JointBasis {
  const bases = new Set(inputs.map((input) => input.basis));
  if (bases.size === 0) return 'mixed';
  if (bases.size === 1 && bases.has('A')) return 'A';
  if ([...bases].every((basis) => basis === 'A' || basis === 'B')) return 'B';
  const [only] = [...bases];
  return bases.size === 1 && only !== undefined ? only : 'mixed';
}
