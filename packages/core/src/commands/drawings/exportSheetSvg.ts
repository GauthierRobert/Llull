import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z, confirmExportControlled } from '../schema';
import { report, exportRefusal } from '../noop';
import { PAPER_MM } from '../../model/sheet';
import { renderSheet } from './exportSheet';
import { isRejection, requireSheet, scaleText } from './sheetOps';

/** A view that shows "every visible solid" (no `entityIds`) puts the whole document in the sheet's reach. */
function hasViewOfEverySolid(doc: CadDocument, params: unknown): boolean {
  const sheetId = typeof params === 'object' && params !== null ? (params as { readonly sheetId?: unknown }).sheetId : undefined;
  const sheet =
    typeof sheetId === 'string' && doc.drawings !== undefined && Object.hasOwn(doc.drawings.sheets, sheetId)
      ? doc.drawings.sheets[sheetId]
      : undefined;
  return sheet?.views.some((view) => view.kind !== 'detail' && view.entityIds === undefined) === true;
}

/**
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data.svg is a self-contained <svg>; view geometry is derived from the model as it is now
 * @failure unknown sheet -> no-op summary, no data
 */
export const exportSheetSvg = defineCommand({
  name: 'export_sheet_svg',
  annotations: { readsMeshTriangles: true, wholeDocumentWhen: hasViewOfEverySolid, readOnly: true, writesArtifact: true },
  description:
    'Export a drawing sheet as a self-contained SVG string (paper frame, title block, every view with ISO line weights, hatched ' +
    'sections, clipped details). Geometry is derived from the CURRENT model, so edits to the model show without touching the sheet. ' +
    'Returns `data`: { svg, sheetId, paper, scale (denominator N), scaleText ("1:2"), widthMm, heightMm, fits, ' +
    'views: [{ id, label, kind, scale, scaleText, bounds: [minX, minY, maxX, maxY] in paper mm }], skipped: [{ id, reason }], warnings: string[] }. ' +
    '`fits` is false when views overflow the drawing area (choose a smaller scale or larger paper). With PMI on the sheet (update_sheet pmiMode ' +
    '"auto", or update_drawing_view pmiIds) the frames, datum symbols, sizes and notes are drawn on the views and `data.pmi` = { placed: ' +
    '[{ viewId, pmiIds }], skipped: [{ pmiId, reason }] } with reason GDT_SHEET_PLANE_NOT_PARALLEL, GDT_SHEET_SOLID_NOT_IN_VIEW, ' +
    'GDT_SHEET_VIEW_KIND_UNSUPPORTED or GDT_PMI_UNKNOWN.',
  params: z.object({
    confirmExportControlled,
    sheetId: z.string().describe('Id of the sheet to export.'),
    showDimensions: z
      .boolean()
      .optional()
      .describe('true = add overall width and height dimensions to each projection view. Default false.'),
  }),
  run: (doc, { confirmExportControlled, sheetId, showDimensions }, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_sheet_svg', 'sheet', confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const sheet = requireSheet(doc, 'export_sheet_svg', sheetId);
    if (isRejection(sheet)) return sheet;
    const rendered = renderSheet(doc, sheet, { showDimensions: showDimensions === true });
    const [widthMm, heightMm] = PAPER_MM[sheet.paper];
    const notes =
      rendered.skipped.length > 0
        ? ` Skipped ${rendered.skipped.length} view(s): ${rendered.skipped.map((s) => `${s.id} (${s.reason})`).join('; ')}.`
        : '';
    const warned = rendered.warnings.length > 0 ? ` WARNING: ${rendered.warnings.join('; ')}.` : '';
    return report(
      doc,
      `Exported sheet ${sheet.id} ("${sheet.name}"): ${rendered.views.length} view(s) at ${scaleText(rendered.scale)}, ${sheet.paper}, ${rendered.svg.length} chars.${notes}${warned}`,
      {
        svg: rendered.svg,
        sheetId: sheet.id,
        paper: sheet.paper,
        scale: rendered.scale,
        scaleText: scaleText(rendered.scale),
        widthMm,
        heightMm,
        fits: rendered.fits,
        views: rendered.views,
        skipped: rendered.skipped,
        warnings: rendered.warnings,
        ...(rendered.pmi === undefined ? {} : { pmi: rendered.pmi }),
      },
    );
  },
});
