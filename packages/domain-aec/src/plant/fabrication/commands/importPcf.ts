import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { isoIssue, refuseIso } from '../codes';
import { networkOf, summarise } from '../pcf/pcfMap';
import { readPcf } from '../pcf/pcfRead';
import { importAsRoute } from '../routeImport/importRoute';
import { getFabrication, lineIdsInUse, withFabrication } from '../state';

/**
 * @affects plant.fabrication.pcfLines[lineId] (one imported line, read-only data in millimetres); with `as route` instead a routed line: tie-ins for the flanged ends, 1 pipe line, its runs and branch runs, inline valves / reducers, field welds and supports, all created by the RTE commands; nothing with `preview`
 * @invariant coordinates and bores are scaled by the file's UNITS-* to mm; the stored line writes back to the same bytes (export_pcf) on the MVP subset; unknown records and attributes are kept verbatim;
 *   one pipeline per file; units are never assumed
 * @failure TAB / line over 1024 characters / missing ISOGEN-FILES / file over 16 MB or 200000 lines -> ISO_PCF_TAB, ISO_PCF_LINE_TOO_LONG, ISO_PCF_HEADER, ISO_PCF_TOO_LARGE (path "line N");
 *   as route: no spec -> ISO_ROUTE_SPEC_MISSING; a line the plan cannot rebuild -> ISO_ROUTE_UNSUPPORTED / ISO_ROUTE_TOO_LARGE; supports without a level -> ISO_ROUTE_NO_LEVEL; any RTE refusal passes through with its own code and the document is unchanged;
 *   missing UNITS-BORE / UNITS-CO-ORDS -> ISO_PCF_UNITS_MISSING; unreadable point or record -> ISO_PCF_RECORD_INVALID (path "line N"); line id in use -> ISO_PCF_LINE_EXISTS; the document is unchanged
 */
export const importPcf = defineCommand({
  name: 'import_pcf',
  description:
    "Read a PCF (Piping Component File, ISOGEN / Alias format) and, unless preview is true, store it as the read-only pipe line `pcf_line` of the document (doc.plant.fabrication.pcfLines, keyed by the file's " +
    'PIPELINE-REFERENCE or lineIdOverride). One pipeline per file; give the file text in `text` (CLI: file=<path>). The header units scale coordinates and bores to mm (UNITS-BORE and UNITS-CO-ORDS ' +
    'are required, never assumed); components PIPE, ELBOW, BEND, TEE, OLET, REDUCER-CONCENTRIC / -ECCENTRIC, FLANGE, FLANGE-BLIND, GASKET, BOLT, VALVE, CAP, WELD, SUPPORT, INSTRUMENT with ' +
    'END-POINT / CENTRE-POINT / BRANCH1-POINT / CO-ORDS, SKEY, ITEM-CODE, WEIGHT, FABRICATION-ITEM / ERECTION-ITEM and the MATERIALS block are read; everything else is kept and written back verbatim by export_pcf ' +
    '(listed in data.unknownRecords with its line). Returns data = { lineId, units: { bore, coords, boltDia?, boltLength? } (as declared in the file; an INCH bore is the nominal NPS and maps to DN, 4 -> 100), componentCount, countsByType, totalPipeLengthMm (sum of PIPE END-POINT distances), pipeLengthsMm[], ' +
    'bom: [{ itemCode, description, count, lengthMm? }], withoutItemCode, unknownRecords: [{ type, line }], warnings: [{ code, severity, message, ids, paths, remediation }], stored }. ' +
    'preview true only reports (document unchanged). Refusals (document unchanged, path "line N"): ISO_PCF_TAB, ISO_PCF_LINE_TOO_LONG, ISO_PCF_HEADER (first line must be ISOGEN-FILES), ISO_PCF_TOO_LARGE, ' +
    'ISO_PCF_UNITS_MISSING, ISO_PCF_RECORD_INVALID, ISO_PCF_LINE_EXISTS (pass lineIdOverride or delete_pcf_line). ' +
    'as route rebuilds the line as a routed, editable line (create_pipeline, route_pipe, add_branch ... from the spec; data.route lists runs, ports, welds, supports and the comparison with the file; data.lineId is then the routed line id, data.lineNumber the PIPELINE-REFERENCE) and adds the refusals ISO_ROUTE_SPEC_MISSING, ISO_ROUTE_UNSUPPORTED, ISO_ROUTE_TOO_LARGE, ISO_ROUTE_NO_LEVEL and every RTE_* code of the nested commands. ' +
    'Next: export_pcf writes it back; delete_pcf_line removes it (a routed line: delete_pipe_run).',
  params: z.object({
    text: z.string().describe('The PCF file content (text). CLI: file=<path> fills it.'),
    preview: z.boolean().optional().describe('true = only parse and report; the document is not changed. Default false.'),
    lineIdOverride: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Store the line under this id instead of the file's PIPELINE-REFERENCE (use when that reference is already in use)."),
    as: z
      .enum(['pcf_line', 'route'])
      .optional()
      .describe(
        'How the line enters the document. pcf_line (default) = the lossless read-only copy that exports back to the same bytes. route = a routed, editable line: the centreline of the file is rebuilt with the 02 RTE commands (create_pipeline, route_pipe, add_branch, insert_inline_component, add_field_weld, add_pipe_support) from the spec, so the fittings, flange sets with gaskets and cut lengths are the spec ones and can differ from the file (reported in data.route.comparison and ISO_ROUTE_DIMENSIONS_CHANGED). Route mode takes pipes, elbows, bends, tees, olets, concentric reducers, valves, end flanges and valve sets, welds and supports; anything else is refused with the components named.',
      ),
    spec: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'as route: id of the piping spec (already in the document, list_pipe_specs) the line is routed with. Default: the PIPING-SPEC of the file.',
      ),
    service: z.string().trim().min(1).optional().describe("as route: service code of the created line (create_pipeline). Default 'PCF'."),
    supports: z
      .boolean()
      .optional()
      .describe(
        'as route: create the supports of the file (SUPPORT records) with add_pipe_support, which needs a building level (ISO_ROUTE_NO_LEVEL without). Default true; false drops them with a warning.',
      ),
    valveType: z
      .enum(['valveGate', 'valveGlobe', 'valveCheck', 'valveBall', 'valveButterfly', 'valvePlug'])
      .optional()
      .describe('as route: catalogue type given to every VALVE of the file (a PCF VALVE does not say which). Default valveGate.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const routeOnly = (['spec', 'service', 'supports', 'valveType'] as const).filter((key) => params[key] !== undefined);
    if (params.as !== 'route' && routeOnly.length > 0)
      return refuseIso(doc, 'import_pcf', 'ISO_PARAM_INVALID', `${routeOnly.join(', ')} apply to as route only`, [], routeOnly.slice());
    const read = readPcf(params.text);
    if (!read.ok) return refuseIso(doc, 'import_pcf', read.code, read.message, [], read.paths);
    const lineId = params.lineIdOverride?.trim() ?? read.file.lineId;
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
      units: read.file.units,
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
    if (params.as === 'route')
      return importAsRoute(
        doc,
        {
          file,
          lineNumber: lineId,
          preview: params.preview === true,
          spec: params.spec,
          service: params.service ?? 'PCF',
          supports: params.supports ?? true,
          valveType: params.valveType ?? 'valveGate',
          base: data,
          warnings,
        },
        ctx,
      );
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
