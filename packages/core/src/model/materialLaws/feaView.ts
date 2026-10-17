/** `FeaConstitutiveView` (PHY-02 §3.5): what a solver deck writer reads of a material + constitutive set at an analysis state. */

import type { MaterialModel, SetSlot } from '../materialModel';
import type { MaterialCards } from './cardWriter';

export interface FeaConstitutiveView {
  readonly recordId: string;
  readonly setId: string;
  /** 05 UnitSystem of the analysis the view was built for. */
  readonly unitSystem: string;
  readonly laws: Readonly<Partial<Record<SetSlot, MaterialModel>>>;
  /** Where temperature-dependent parameters were tabulated (K). */
  readonly temperatureTablesK?: readonly number[];
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  readonly reviewRequired: boolean;
}

/**
 * View of a set from the cards written for it: unverified / reviewRequired propagate unchanged (TR-MATL-13).
 * @invariant `unverified` is true exactly when `unverifiedReasons` is non-empty
 */
export function buildFeaConstitutiveView(
  recordId: string,
  setId: string,
  unitSystem: string,
  laws: Readonly<Partial<Record<SetSlot, MaterialModel>>>,
  cards: Pick<MaterialCards, 'unverifiedReasons' | 'reviewRequired'>,
  temperaturesK: readonly number[] = [],
): FeaConstitutiveView {
  return {
    recordId,
    setId,
    unitSystem,
    laws,
    ...(temperaturesK.length > 0 ? { temperatureTablesK: temperaturesK } : {}),
    unverified: cards.unverifiedReasons.length > 0,
    unverifiedReasons: cards.unverifiedReasons,
    reviewRequired: cards.reviewRequired,
  };
}
