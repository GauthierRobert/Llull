/** Bases of the inputs of a comparison (PHY-12 TR-SEL-10): several bases in one comparison compare unlike values. */

import { issue } from './codes';
import type { PropertyUse, SelIssue } from './types';

/** Sorted distinct bases of the inputs. */
export const basesOf = (inputs: readonly PropertyUse[]): string[] => [...new Set(inputs.map((input) => input.basis))].sort();

/** SEL_VALUE_UNVERIFIED once for a whole answer (the per-row warnings carry the detail). */
export function unverifiedSummary(materials: readonly string[], reasons: readonly string[]): SelIssue[] {
  return reasons.length === 0 ? [] : [issue('SEL_VALUE_UNVERIFIED', 'warning', [...new Set(reasons)].sort().join('; '), materials)];
}

/** SEL_BASIS_MIXED when more than one basis is in play (empty list otherwise). */
export function mixedBasesWarning(bases: readonly string[], materials: readonly string[]): SelIssue[] {
  return bases.length > 1 ? [issue('SEL_BASIS_MIXED', 'warning', `inputs use different bases: ${bases.join(', ')}`, materials)] : [];
}
