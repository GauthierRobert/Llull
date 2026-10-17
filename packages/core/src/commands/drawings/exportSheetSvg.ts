import type { CommandResult } from '../types';
import { defineCommand, z, confirmExportControlled } from '../schema';
import { report, exportRefusal } from '../noop';
import { PAPER_MM } from '../../model/sheet';
import { renderSheet } from './exportSheet';
import { isRejection, requireSheet, scaleText } from './sheetOps';

/**
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data.svg is a self-contained <svg>; view geometry is derived from the model as it is now
 * @failure unknown sheet -> no-op summary, no data
 */
export const exportSheetSvg = defineCommand({
  name: 'export_sheet_svg',
  annotations: { readOnly: true },
  description:
    'Export a drawing sheet as a self-contained SVG string (paper frame, title block, every view with ISO line weights, hatched ' +
    'sections, clipped details). Geometry is derived from the CURRENT model, so edits to the model show without touching the sheet. ' +
    'Returns `data`: { svg, sheetId, paper, scale (denominator N), scaleText ("1:2"), widthMm, heightMm, fits, ' +
    'views: [{ id, label, kind, scale, scaleText, bounds: [minX, minY, maxX, maxY] in paper mm }], skipped: [{ id, reason }], warnings: string[] }. ' +
    '`fits` is false when views overflow the drawing area (choose a smaller scale or larger paper).',
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
    const overflow = rendered.fits ? '' : ' WARNING: views overflow the drawing area; use a smaller scale or larger paper.';
    return report(
      doc,
      `Exported sheet ${sheet.id} ("${sheet.name}"): ${rendered.views.length} view(s) at ${scaleText(rendered.scale)}, ${sheet.paper}, ${rendered.svg.length} chars.${notes}${overflow}${warned}`,
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
      },
    );
  },
});
