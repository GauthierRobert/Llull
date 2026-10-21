/** Read-only views of the `plm` slice that core drawings consume (09 PLM FR-PLM-14, FR-PLM-25, FR-PLM-26): nothing is copied into the sheet data. */

import type { DocumentProjections } from '@core/plugins/plugin';

const UNRELEASED = new Set(['in_work', 'in_review', 'cancelled']);

/**
 * The sheet as printed: part number and revision follow `doc.plm.item` (an unreleased revision reads "B (IN WORK)"), and the export-control
 * notice is returned for the frame. A document without a managed item prints its own title block unchanged.
 * @invariant pure; never changes the stored sheet
 */
const printedSheet: NonNullable<DocumentProjections['printedSheet']> = (doc, sheet) => {
  const item = doc.plm?.item;
  if (item === undefined) return { sheet, notice: undefined };
  const state = item.revisions[item.currentRevision]?.state;
  const revision =
    state !== undefined && UNRELEASED.has(state)
      ? `${item.currentRevision} (${state.replace('_', ' ').toUpperCase()})`
      : item.currentRevision;
  const statement = item.marking.statement?.trim();
  return {
    sheet: { ...sheet, titleBlock: { ...sheet.titleBlock, partNumber: item.partNumber, revision } },
    notice: statement === undefined || statement === '' ? undefined : statement,
  };
};

/** @invariant a retired characteristic has no number; the number is the register's, so it survives regeneration */
const characteristicNumber: NonNullable<DocumentProjections['characteristicNumber']> = (doc, pmiId) => {
  const characteristic = doc.plm?.characteristics?.[pmiId];
  return characteristic === undefined || characteristic.retiredIn !== undefined ? undefined : characteristic.charNo;
};

export const plmProjections: DocumentProjections = { printedSheet, characteristicNumber };
