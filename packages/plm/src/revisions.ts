/** Builders of PLM records: a fresh revision and the plm slice updates the commands share. */

import type { CadDocument } from '@core/model/types';
import type { ManagedItem, PlmModel, Revision } from '@core/model/plm';
import { stateChange } from './state';

/** A new in_work revision at iteration 1 with the definition hash `contentHash`. */
export function openRevision(
  label: string,
  contentHash: string,
  at: string | undefined,
  by: string | undefined,
  extra: { readonly basedOn?: string; readonly changeOrder?: string } = {},
): Revision {
  return {
    label,
    state: 'in_work',
    ...(extra.basedOn !== undefined ? { basedOn: extra.basedOn } : {}),
    iterations: [{ n: 1, contentHash, ...(at !== undefined ? { at } : {}), ...(by !== undefined ? { by } : {}) }],
    ...(extra.changeOrder !== undefined ? { changeOrder: extra.changeOrder } : {}),
    effectivity: [],
    approvals: [],
    signatures: [],
    stateHistory: [stateChange(null, 'in_work', at, by)],
  };
}

/** `doc` with revision `label` replaced (the item's other revisions keep their identity). */
export function withRevision(doc: CadDocument, plm: PlmModel, label: string, revision: Revision): CadDocument {
  const item: ManagedItem = { ...plm.item, revisions: { ...plm.item.revisions, [label]: revision } };
  return { ...doc, plm: { ...plm, item } };
}

/** `doc` with the plm slice replaced. */
export const withPlm = (doc: CadDocument, plm: PlmModel): CadDocument => ({ ...doc, plm });
