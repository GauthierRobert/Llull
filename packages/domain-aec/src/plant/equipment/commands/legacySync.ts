/** Writes the legacy equipment fields back from the plant data in the same command (decision Q1 / D6). */

import type { CadDocument } from '@core/model/types';
import type { EquipmentElement } from '@aec/building/types';
import { legacyFields } from '../geometry/legacyFields';

/**
 * @returns `element` with `size` / `shape` / `weight` re-derived from `element.plant` (a block or an invalid vessel keeps its fields), and the
 *   assumptions of the weight
 */
export function withLegacyFields(doc: CadDocument, element: EquipmentElement): { element: EquipmentElement; notes: readonly string[] } {
  const derived = element.plant === undefined ? null : legacyFields(doc, element.plant);
  if (derived === null) return { element, notes: [] };
  const next: EquipmentElement = { ...element, size: derived.size, weight: derived.weight };
  if (derived.shape === 'box') delete next.shape;
  else next.shape = derived.shape;
  return { element: next, notes: derived.notes };
}
