import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { analyseLine, isAnalysis } from '../analysis';
import { refuseIso } from '../codes';
import { cutPieces } from '../cutList';
import { isWeldJoint } from '../joints';

/**
 * @affects none (query: returns the same document)
 * @invariant cut = centreline length - gap / 2 per welded end + allowance per field-fit end (each adjoining cut gets the allowance); gap and allowance come from the params or set_fabrication_rules, with their source; none is assumed
 * @failure unknown line -> ISO_LINE_NOT_FOUND; unknown spool -> ISO_SPOOL_NOT_FOUND; gap (or the allowance of a line with field-fit welds) given nowhere -> ISO_GAP_UNDEFINED; a cut piece not longer than max(0, minCutPieceMm) -> ISO_CUT_LENGTH_SHORT
 */
export const cutList = defineCommand({
  name: 'cut_list',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Cut list of a pipe line for the shop: one row per pipe piece of each spool (piece name <spool>-P1 ..., component id, bore, item code), its centreline length (between the joint points, fitting take-outs already ' +
    'excluded) and its cut length = centreline length - weldGapMm / 2 for each welded end + fieldFitAllowanceMm for each end at a field-fit (WF) weld. The gap and the allowance are never assumed: pass them or store ' +
    'them with set_fabrication_rules (weldGapMm, fieldFitAllowanceMm, with a source); the allowance is only needed when the line has a field-fit weld (set_weld_type, or SKEY WF in an imported PCF). ' +
    'Spools break as stored by split_spools. Returns data = { lineId, pieces: [{ piece, spool, componentId, boreMm, itemCode, centrelineLengthMm, cutLengthMm, adjustments: [{ end, kind, mm }] }], ' +
    'totalMm (sum of cut lengths), centrelineTotalMm, provenance: { weldGapMm: { value, source }, fieldFitAllowanceMm?, minCutPieceMm? } }. Lengths in mm. ' +
    'Refusals: ISO_LINE_NOT_FOUND, ISO_SPOOL_NOT_FOUND, ISO_GAP_UNDEFINED, ISO_CUT_LENGTH_SHORT (a piece not longer than minCutPieceMm, or than 0).',
  params: z.object({
    lineId: z.string().min(1).describe('The line: routed line id, imported PCF line number or legacy pipe line number.'),
    spoolId: z.string().min(1).optional().describe('Only the pieces of this spool (a name from spool_list, e.g. L-101-SP02).'),
    weldGapMm: z
      .number()
      .min(0)
      .optional()
      .describe('Weld gap in mm for this call; else the stored rule (set_fabrication_rules). Refused when neither exists.'),
    fieldFitAllowanceMm: z
      .number()
      .min(0)
      .optional()
      .describe('Allowance in mm added at each field-fit weld end for this call; else the stored rule.'),
  }),
  run: (doc, params): CommandResult => {
    const analysis = analyseLine(doc, 'cut_list', params.lineId);
    if (!isAnalysis(analysis)) return analysis;
    const rules = analysis.fabrication.rules;
    const names = analysis.spools.spools.map((spool) => spool.name);
    if (params.spoolId !== undefined && !names.includes(params.spoolId))
      return refuseIso(
        doc,
        'cut_list',
        'ISO_SPOOL_NOT_FOUND',
        `line ${params.lineId} has no spool "${params.spoolId}" (${names.join(', ')})`,
        [params.lineId],
        ['spoolId'],
      );
    const gap = params.weldGapMm === undefined ? rules?.weldGapMm : { value: params.weldGapMm, source: 'param weldGapMm' };
    const allowance =
      params.fieldFitAllowanceMm === undefined
        ? rules?.fieldFitAllowanceMm
        : { value: params.fieldFitAllowanceMm, source: 'param fieldFitAllowanceMm' };
    const hasFieldFit = [...analysis.classes.values()].some((kind) => kind === 'field_fit');
    if (gap === undefined)
      return refuseIso(
        doc,
        'cut_list',
        'ISO_GAP_UNDEFINED',
        'no weld gap: pass weldGapMm or store it with set_fabrication_rules',
        [params.lineId],
        ['weldGapMm'],
      );
    if (hasFieldFit && allowance === undefined)
      return refuseIso(
        doc,
        'cut_list',
        'ISO_GAP_UNDEFINED',
        'the line has field-fit welds but no field-fit allowance: pass fieldFitAllowanceMm or store it with set_fabrication_rules',
        [params.lineId],
        ['fieldFitAllowanceMm'],
      );
    const minimum = rules?.minCutPieceMm;
    const all = cutPieces(analysis, gap.value, allowance?.value ?? 0);
    const pieces = all.filter((piece) => params.spoolId === undefined || piece.spool === params.spoolId);
    const short = pieces.filter((piece) => piece.cutLengthMm <= Math.max(0, minimum?.value ?? 0));
    if (short.length > 0)
      return refuseIso(
        doc,
        'cut_list',
        'ISO_CUT_LENGTH_SHORT',
        `${short.length} piece(s) too short: ${short.map((piece) => `${piece.piece} ${piece.cutLengthMm} mm`).join(', ')}`,
        short.map((piece) => piece.componentId),
        ['weldGapMm'],
      );
    const weldsAnywhere = [...analysis.classes.values()].some(isWeldJoint);
    const total = pieces.reduce((sum, piece) => sum + piece.cutLengthMm, 0);
    return report(
      doc,
      `cut_list: line ${params.lineId}: ${pieces.length} piece(s), total cut ${Math.round(total * 1e6) / 1e6} mm (gap ${gap.value} mm from ${gap.source}${hasFieldFit ? `, field-fit allowance ${allowance?.value} mm` : ''})${weldsAnywhere ? '' : '; no welds'}`,
      {
        lineId: params.lineId,
        pieces,
        totalMm: Math.round(total * 1e6) / 1e6,
        centrelineTotalMm: Math.round(pieces.reduce((sum, piece) => sum + piece.centrelineLengthMm, 0) * 1e6) / 1e6,
        provenance: {
          weldGapMm: gap,
          ...(allowance === undefined ? {} : { fieldFitAllowanceMm: allowance }),
          ...(minimum === undefined ? {} : { minCutPieceMm: minimum }),
        },
      },
    );
  },
});
