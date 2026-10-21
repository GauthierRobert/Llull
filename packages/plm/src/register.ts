/** The characteristic register of a revision (FR-PLM-26): which numbered characteristics belong to which revision. */

import type { Characteristic, PlmModel } from '@plm/types';

/** Whether characteristic `c` belongs to revision `label`: introduced at or before it, not retired at or before it. */
export function inRevision(plm: PlmModel, c: Characteristic, label: string): boolean {
  const order = plm.item.revisionOrder;
  const at = order.indexOf(label);
  const born = order.indexOf(c.introducedIn);
  const retired = c.retiredIn === undefined ? -1 : order.indexOf(c.retiredIn);
  return born !== -1 && born <= at && (retired === -1 || retired > at);
}
