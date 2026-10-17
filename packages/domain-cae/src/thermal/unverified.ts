/** Unverified-input propagation (PHY-03 FR-THM-22): the k / cp / density inputs of a case whose basis or range is not verified. */

import type { CadDocument } from '@core/model/types';
import type { ThermalCase } from './access';
import { caseTables } from './material';

export interface UnverifiedInputs {
  readonly unverified: boolean;
  readonly reasons: readonly string[];
  /** `[materialId, property]` pairs with their reasons, for check items. */
  readonly entries: readonly { readonly materialId: string; readonly property: string; readonly reasons: readonly string[] }[];
}

/** Flags of the property inputs the case reads (a property that cannot be read is reported by check_thermal, not here). */
export function unverifiedInputs(doc: CadDocument, found: ThermalCase): UnverifiedInputs {
  const entries = caseTables(doc, found).flatMap(({ materialId, property, table }) =>
    !('code' in table) && table.unverifiedReasons.length > 0 ? [{ materialId, property, reasons: table.unverifiedReasons }] : [],
  );
  return { unverified: entries.length > 0, reasons: entries.map((e) => `${e.materialId}.${e.property}: ${e.reasons.join(', ')}`), entries };
}
