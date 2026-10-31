import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import { exportRefusal, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { xlsxSheetName } from '@lib/xlsxWrite';
import { buildReport } from '../plantReports/build';
import { csvFile, xlsxFile, xlsxSheetOf, type DataFile } from '../plantReports/files';
import { applyDefinition } from '../plantReports/definition';
import { MTO_DIMENSIONS, type MtoDimension } from '../plantReports/mto';
import { getPlantData } from '../model';
import { REPORT_KINDS, type ReportRow } from '../plantReports/types';
import { refuse } from './params';

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 20000;

/**
 * @affects none; data = { kind, columns, rows, total, offset, limit, rowsByTag?, totals, method, defaults, files? }
 * @invariant rows in natural tag order (P-2 before P-10); identical input -> identical rows, csv text and xlsx bytes; legacy pipes are measured on the centreline, routed runs by cut length with the catalogue take-outs
 * @failure csv / xlsx of controlled content without a human confirmation -> MAT_EXPORT_CONTROLLED / MAT_HUMAN_GATE; unknown hierarchy node -> DAT_HIERARCHY_UNKNOWN; custom without a definition -> DAT_REPORT_KIND_UNAVAILABLE; groupBy on another kind -> DAT_PARAM_INVALID; document unchanged
 */
export const plantReport = defineCommand({
  name: 'plant_report',
  description:
    'Report on the plant objects as typed rows (pure, document unchanged). kind: line_list (one row per process line: line number, class, DN, fluid, spec, from, to, ' +
    'whether each end resolves, centreline length in m, straights, bends, design and operating conditions, hierarchy, unverified flag); equipment_list (tag, class, ' +
    'description, design conditions, size in m, OperatingWeightKg, hierarchy); nozzle_schedule (one row per nozzle: the nozzles of 03 EQP equipment (add_nozzle) with their DN, rating ' +
    'and facing, inferred false, the line and flow direction from the line whose from / to names "<tag>:<mark>" or the routed run that ends at it; for other equipment nozzles INFERRED ' +
    'where a line end lies inside the equipment its from / to names: N1, N2 per equipment in line creation order, DN of the line, SOURCE for the from end and SINK for the to end, ' +
    'inferred true); valve_list (one row per valve: plant objects of the Valve class family standing for valves of routed runs, with component type, DN, face-to-face length in mm, spec, ' +
    'line, run, status modelled / reserved / orphan; valves of the runs without a plant object are listed unclassified when no hierarchy is given); instrument_index (one row per P&ID ' +
    'instrument of add_pid_instrument with ISA functions, loop, location, display, sheet, measured line and the plant object (class, hierarchy) when one stands for it, else status ' +
    'unclassified when no hierarchy is given); mto (material take-off grouped by groupBy, default spec, itemType, nominalSize: legacy pipes by centreline in m with bends in ea; routed ' +
    'runs by cut length in m with the take-outs of the 01 PSC catalogue deducted and every fitting, flange, gasket, bolt set and valve counted in ea under its takeoff key such as ' +
    'elbow90LR or valveGate; method is centreline, cutLength or mixed and each row names its basis and source lines); tag_register (every tag in scope with class, target kind, status ' +
    'modelled / reserved / orphan; with no hierarchy it also lists the tags of P&ID instruments no plant object stands for, reserved, target kind pidInstrument). ' +
    'kind custom is refused with DAT_REPORT_KIND_UNAVAILABLE unless a definition is given. definition: the id of a template saved with save_report_definition (kind may then be omitted): it keeps the ' +
    'chosen columns, adds computed columns, filters and sorts. hierarchy: only objects at that node or below (code, path S1/P1/U10 or id). format json (default): data only; ' +
    'csv or xlsx: also data.files = [{ fileName, content | base64 }] with ALL rows (save with --save), header "Name (unit)". Rows are sorted by tag in natural order. ' +
    'offset / limit page data.rows (limit at most 20000, default 2000); total counts all rows; totals sum the whole report. rowsByTag indexes the returned rows by their ' +
    'key (tag, or equipment/nozzle for nozzle_schedule) when keys are unique. Values flagged unverified are never hidden: the unverified column is true. ' +
    'Refusals: DAT_HIERARCHY_UNKNOWN, DAT_REPORT_KIND_UNAVAILABLE, DAT_PARAM_INVALID.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    confirmExportControlled,
    kind: z
      .enum(REPORT_KINDS)
      .optional()
      .describe(
        'Report kind: line_list, equipment_list, nozzle_schedule, valve_list, instrument_index, mto, tag_register; custom needs definition. Omit it when definition is given.',
      ),
    definition: z
      .string()
      .optional()
      .describe(
        'Id of a report saved with save_report_definition: its kind, hierarchy, groupBy, columns, computed columns, filter and sort apply (hierarchy / groupBy given here win).',
      ),
    hierarchy: z
      .string()
      .optional()
      .describe('Hierarchy node (code, path S1/P1/U10 or id) to restrict the report to; omit for the whole plant.'),
    groupBy: z
      .array(z.enum(MTO_DIMENSIONS))
      .min(1)
      .optional()
      .describe(
        'mto only: dimensions to group by, from spec, itemType, nominalSize, line, hierarchy. Default spec, itemType, nominalSize.',
      ),
    format: z.enum(['json', 'csv', 'xlsx']).optional().describe('json (default): rows in data. csv / xlsx: also a file in data.files.'),
    offset: z.number().int().min(0).optional().describe('Rows of data.rows to skip (paging). Default 0.'),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('Rows of data.rows to return, 1-20000. Default 2000.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    if ((params.format ?? 'json') !== 'json') {
      const gated = exportRefusal(doc, 'plant_report', 'data', params.confirmExportControlled, ctx);
      if (gated !== null) return gated;
    }
    const definition = params.definition === undefined ? undefined : getPlantData(doc).reports?.[params.definition];
    if (params.definition !== undefined && definition === undefined)
      return refuse(doc, 'plant_report', {
        code: 'DAT_PARAM_INVALID',
        message: `no report definition "${params.definition}" (save_report_definition)`,
        paths: ['definition'],
      });
    if (definition !== undefined && params.kind !== undefined && params.kind !== 'custom' && params.kind !== definition.kind)
      return refuse(doc, 'plant_report', {
        code: 'DAT_PARAM_INVALID',
        message: `definition ${definition.id} is a ${definition.kind} report, not ${params.kind}`,
        paths: ['kind'],
      });
    const kind = definition?.kind ?? params.kind;
    if (kind === undefined)
      return refuse(doc, 'plant_report', { code: 'DAT_PARAM_INVALID', message: 'send kind or definition', paths: ['kind'] });
    const built = buildReport(doc, {
      kind,
      hierarchy: params.hierarchy ?? definition?.hierarchy,
      groupBy: params.groupBy ?? (definition?.groupBy as MtoDimension[] | undefined),
    });
    if (!built.ok) return refuse(doc, 'plant_report', { code: built.code, message: built.message, paths: [built.path] });
    const shaped = definition === undefined ? built : applyDefinition(built.table, definition);
    if (!shaped.ok) return refuse(doc, 'plant_report', { code: shaped.code, message: shaped.message, paths: [shaped.path] });
    const { table } = shaped;
    const offset = params.offset ?? 0;
    const limit = params.limit ?? DEFAULT_LIMIT;
    const rows = table.rows.slice(offset, offset + limit);
    const fileStem = (definition?.id ?? kind).replace(/_/g, '-');
    const format = params.format ?? 'json';
    const files: DataFile[] =
      format === 'csv'
        ? [csvFile(`${fileStem}.csv`, table)]
        : format === 'xlsx'
          ? [xlsxFile(`${fileStem}.xlsx`, [xlsxSheetOf(xlsxSheetName(fileStem.replace(/-/g, ' '), []), table, false, () => false)])]
          : [];
    const keys = table.keyColumn === null ? [] : rows.map((row) => String(row[table.keyColumn as string] ?? ''));
    const rowsByTag: Record<string, ReportRow> | undefined =
      table.keyColumn !== null && new Set(keys).size === keys.length
        ? Object.fromEntries(rows.map((row, index) => [keys[index] as string, row]))
        : undefined;
    return report(
      doc,
      `plant_report ${definition?.id ?? kind}: ${table.rows.length} row(s)${params.hierarchy === undefined ? '' : ` under ${params.hierarchy}`}` +
        (Object.keys(table.totals).length === 0
          ? ''
          : ` (${Object.entries(table.totals)
              .map(([name, value]) => `${name} ${value}`)
              .join(', ')})`) +
        (files[0] === undefined ? '.' : `; file ${files[0].fileName}.`),
      {
        kind,
        ...(definition === undefined ? {} : { definition: definition.id }),
        columns: table.columns,
        rows,
        total: table.rows.length,
        offset,
        limit,
        ...(rowsByTag === undefined ? {} : { rowsByTag }),
        totals: table.totals,
        method: table.method,
        defaults: table.defaults,
        ...(files.length === 0 ? {} : { files, fileName: files[0]?.fileName }),
      },
    );
  },
});
