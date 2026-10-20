/** Render-time projection of the managed item (09 PLM FR-PLM-14, FR-PLM-25) onto a sheet: nothing is copied into the sheet data. */

import type { CadDocument } from '../../model/types';
import type { DrawingSheet } from '../../model/sheet';

const UNRELEASED = new Set(['in_work', 'in_review', 'cancelled']);

/**
 * The sheet as printed: part number and revision follow `doc.plm.item` (an unreleased revision reads "B (IN WORK)"), and the export-control
 * notice is returned for the frame. A document without a managed item prints its own title block unchanged.
 * @invariant pure; never changes the stored sheet
 */
export function managedSheet(doc: CadDocument, sheet: DrawingSheet): { readonly sheet: DrawingSheet; readonly notice: string | undefined } {
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
}
