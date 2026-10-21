/** Render-time projection of a plugin's managed item (e.g. 09 PLM FR-PLM-14, FR-PLM-25) onto a sheet: nothing is copied into the sheet data. */

import type { CadDocument } from '../../model/types';
import type { DrawingSheet } from '../../model/sheet';
import { documentProjection } from '../../plugins/host';

/**
 * The sheet as printed and the export-control notice for the frame; a document without an installed projection (or without a managed item)
 * prints its own title block unchanged.
 * @invariant pure; never changes the stored sheet
 */
export function managedSheet(doc: CadDocument, sheet: DrawingSheet): { readonly sheet: DrawingSheet; readonly notice: string | undefined } {
  return documentProjection('printedSheet')?.(doc, sheet) ?? { sheet, notice: undefined };
}
