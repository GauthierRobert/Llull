/** Derived-entity listing for persistence (architecture L8: evaluated geometry is re-derivable). */

import type { CadDocument } from './types';
import { documentExtensions } from '../plugins/host';

/**
 * Entity ids regenerated from the definition by an installed plugin's pure deriver (today: the
 * building plugin via `regenerateBuilding`). Persistence omits these and re-derives them on load.
 */
export function derivedEntityIds(doc: CadDocument): Set<string> {
  const ids = new Set<string>();
  for (const extension of documentExtensions())
    for (const id of extension.derivedEntityIds(doc)) ids.add(id);
  return ids;
}
