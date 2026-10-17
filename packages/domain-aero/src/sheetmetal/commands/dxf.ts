import { defineCommand, z, confirmExportControlled } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report, exportRefusal } from '@core/commands/noop';
import { DOCUMENT_UNITS } from '@core/model/types';
import { buildFlatDxf } from '../dxfFlat';
import { buildFlat, isRefusal } from '../flatData';
import { REVIEW_NOTE, fixed, unverifiedNote } from '../result';

/**
 * @affects none; data = { partId, filename, dxf, unit, extents, entityCount, layers[], insunits } + FtrResultMeta
 * @invariant only LINE / CIRCLE / TEXT; layers OUTLINE, CUTOUT, BEND_UP, BEND_DOWN, NOTES; NOTES carries the review reason and the unverified inputs
 * @failure unknown part / undevelopable part -> rejected with error.code
 */
export const exportFlatPatternDxf = defineCommand({
  name: 'export_flat_pattern_dxf',
  description:
    'Export the flat pattern of a sheet-metal part as an AutoCAD R12 DXF text (data.dxf; save it with the CLI --save option): outline and cutouts as LINE / CIRCLE entities on layers OUTLINE and CUTOUT, ' +
    'bend lines on BEND_UP and BEND_DOWN, and TEXT notes on NOTES (the "not approved — a qualified person must review" note, every unverified input and, optionally, one bend note per bend). ' +
    'The pattern is shifted so its bounding box starts at the origin; $INSUNITS follows `units` (default: the document length unit, echoed in data.unit). ' +
    'Refusals: FTR_PART_NOT_FOUND, FTR_NON_DEVELOPABLE. Run check_sheet_metal first.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    confirmExportControlled,
    id: z.string().describe('Sheet-metal part id (returned by add_sheet_metal_base).'),
    units: z
      .enum(DOCUMENT_UNITS)
      .optional()
      .describe('Unit of the DXF coordinates: mm, cm, m, in or ft. Default: the document length unit.'),
    bendLines: z.boolean().optional().describe('Write bend lines on BEND_UP / BEND_DOWN (default true).'),
    bendNotes: z
      .boolean()
      .optional()
      .describe('Write one TEXT note per bend (angle in degrees, inside radius, K, BA) on NOTES (default true).'),
  }),
  run: (doc, { confirmExportControlled, id, units, bendLines = true, bendNotes = true }, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_flat_pattern_dxf', 'data', confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const built = buildFlat(doc, 'export_flat_pattern_dxf', id);
    if (isRefusal(built)) return built.refusal;
    const unit = units ?? doc.units;
    const dxf = buildFlatDxf(built, doc.units, unit, { bendLines, bendNotes });
    const data = {
      partId: id,
      filename: `${id}_flat.dxf`,
      dxf: dxf.text,
      unit,
      unitDefaulted: units === undefined,
      extents: dxf.extents,
      entityCount: dxf.entityCount,
      layers: dxf.layers,
      ...built.meta,
      lengthUnit: unit,
    };
    return report(
      doc,
      `export_flat_pattern_dxf ${id}: ${data.filename}, ${dxf.entityCount} entities on layers ${dxf.layers.join(', ')}, ${fixed(dxf.extents[0])} x ${fixed(dxf.extents[1])} ${unit}.${unverifiedNote(built.meta)} ${REVIEW_NOTE}`,
      data,
    );
  },
});
