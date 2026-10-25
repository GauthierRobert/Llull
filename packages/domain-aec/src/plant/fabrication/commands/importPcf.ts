import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { isoIssue, refuseIso } from '../codes';
import { networkOf, summarise } from '../pcf/pcfMap';
import { readPcf } from '../pcf/pcfRead';
import { getFabrication, lineIdsInUse, withFabrication } from '../state';

/**
 * @affects plant.fabrication.pcfLines[lineId] (one imported line, read-only data in millimetres); nothing with `preview`
 * @invariant coordinates and bores are scaled by the file's UNITS-* to mm; the stored line writes back to the same bytes (export_pcf) on the MVP subset; unknown records and attributes are kept verbatim;
 *   one pipeline per file; units are never assumed
 * @failure TAB / line over 1024 characters / missing ISOGEN-FILES / file over 16 MB or 200000 lines -> ISO_PCF_TAB, ISO_PCF_LINE_TOO_LONG, ISO_PCF_HEADER, ISO_PCF_TOO_LARGE (path "line N");
 *   missing UNITS-BORE / UNITS-CO-ORDS -> ISO_PCF_UNITS_MISSING; unreadable point or record -> ISO_PCF_RECORD_INVALID (path "line N"); line id in use -> ISO_PCF_LINE_EXISTS; the document is unchanged
 */
export const importPcf = defineCommand({
  name: 'import_pcf',
  description:
    "Read a PCF (Piping Component File, ISOGEN / Alias format) and, unless preview is true, store it as the read-only pipe line `pcf_line` of the document (doc.plant.fabrication.pcfLines, keyed by the file's " +
    'PIPELINE-REFERENCE or lineIdOverride). One pipeline per file; give the file text in `text` (CLI: file=<path>). The header units scale coordinates and bores to mm (UNITS-BORE and UNITS-CO-ORDS ' +
    'are required, never assumed); components PIPE, ELBOW, BEND, TEE, OLET, REDUCER-CONCENTRIC / -ECCENTRIC, FLANGE, FLANGE-BLIND, GASKET, BOLT, VALVE, CAP, WELD, SUPPORT, INSTRUMENT with ' +
    'END-POINT / CENTRE-POINT / BRANCH1-POINT / CO-ORDS, SKEY, ITEM-CODE, WEIGHT, FABRICATION-ITEM / ERECTION-ITEM and the MATERIALS block are read; everything else is kept and written back verbatim by export_pcf ' +
    '(listed in data.unknownRecords with its line). Returns data = { lineId, units: { bore, coords } (as declared in the file), componentCount, countsByType, totalPipeLengthMm (sum of PIPE END-POINT distances), pipeLengthsMm[], ' +
    'bom: [{ itemCode, description, count, lengthMm? }], withoutItemCode, unknownRecords: [{ type, line }], warnings: [{ code, severity, message, ids, paths, remediation }], stored }. ' +
    'preview true only reports (document unchanged). Refusals (document unchanged, path "line N"): ISO_PCF_TAB, ISO_PCF_LINE_TOO_LONG, ISO_PCF_HEADER (first line must be ISOGEN-FILES), ISO_PCF_TOO_LARGE, ' +
    'ISO_PCF_UNITS_MISSING, ISO_PCF_RECORD_INVALID, ISO_PCF_LINE_EXISTS (pass lineIdOverride or delete_pcf_line). Next: export_pcf writes it back; delete_pcf_line removes it.',
  params: z.object({
    text: z.string().describe('The PCF file content (text). CLI: file=<path> fills it.'),
    preview: z.boolean().optional().describe('true = only parse and report; the document is not changed. Default false.'),
    lineIdOverride: z
      .string()
      .min(1)
      .optional()
      .describe("Store the line under this id instead of the file's PIPELINE-REFERENCE (use when that reference is already in use)."),
    as: z
      .enum(['pcf_line'])
      .optional()
      .describe(
        'How the line enters the document: pcf_line = read-only stored line (the only mode so far; routed components from a PCF arrive with plant 05 ISO M5).',
      ),
  }),
  run: (doc, params): CommandResult => {
    const read = readPcf(params.text);
    if (!read.ok) return refuseIso(doc, 'import_pcf', read.code, read.message, [], read.paths);
    const lineId = params.lineIdOverride?.trim() || read.file.lineId;
    const file = { ...read.file, lineId };
    const taken = lineIdsInUse(doc).has(lineId);
    if (taken && params.preview !== true)
      return refuseIso(
        doc,
        'import_pcf',
        'ISO_PCF_LINE_EXISTS',
        `the line "${lineId}" already exists`,
        [lineId],
        params.lineIdOverride === undefined ? ['PIPELINE-REFERENCE'] : ['lineIdOverride'],
      );
    const summary = summarise(networkOf(file).components);
    const warnings = [
      ...read.warnings,
      ...(taken
        ? [isoIssue('ISO_PCF_LINE_EXISTS', 'warning', `the line "${lineId}" already exists: import_pcf would be refused`, [lineId])]
        : []),
    ];
    const data = {
      lineId,
      units: { bore: read.sourceUnits.bore, coords: read.sourceUnits.coords },
      componentCount: summary.componentCount,
      countsByType: summary.countsByType,
      totalPipeLengthMm: summary.totalPipeLengthMm,
      pipeLengthsMm: summary.pipeLengthsMm,
      bom: summary.bom,
      withoutItemCode: summary.withoutItemCode,
      unknownRecords: file.unknownRecords.map((record) => ({ type: record.type, line: record.line })),
      warnings,
      stored: params.preview !== true,
    };
    const text =
      `${summary.componentCount} component(s) (${Object.entries(summary.countsByType)
        .map(([type, count]) => `${type} ${count}`)
        .join(', ')}), pipe ${summary.totalPipeLengthMm.toFixed(1)} mm in ${summary.pipeLengthsMm.length} piece(s)` +
      `${file.unknownRecords.length === 0 ? '' : `, ${file.unknownRecords.length} unknown record(s) kept`}`;
    if (params.preview === true) return report(doc, `import_pcf preview: line ${lineId}${taken ? ' (id in use)' : ''}, ${text}`, data);
    const fabrication = getFabrication(doc);
    return {
      document: withFabrication(doc, { ...fabrication, pcfLines: { ...fabrication.pcfLines, [lineId]: file } }),
      summary: `import_pcf: stored line ${lineId} as pcf_line, ${text}`,
      affected: [lineId],
      data,
    };
  },
});
