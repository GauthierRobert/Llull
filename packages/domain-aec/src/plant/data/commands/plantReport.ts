import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import { exportRefusal, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { xlsxSheetName } from '@lib/xlsxWrite';
import { buildReport } from '../plantReports/build';
import { csvFile, xlsxFile, xlsxSheetOf, type DataFile } from '../plantReports/files';
import { MTO_DIMENSIONS } from '../plantReports/mto';
import { REPORT_KINDS, type ReportRow } from '../plantReports/types';
import { refuse } from './params';

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 20000;

/**
 * @affects none; data = { kind, columns, rows, total, offset, limit, rowsByTag?, totals, method, defaults, files? }
 * @invariant rows in natural tag order (P-2 before P-10); identical input -> identical rows, csv text and xlsx bytes; lengths are centreline lengths in metres
 * @failure csv / xlsx of controlled content without a human confirmation -> MAT_EXPORT_CONTROLLED / MAT_HUMAN_GATE; unknown hierarchy node -> DAT_HIERARCHY_UNKNOWN; valve_list, instrument_index, custom -> DAT_REPORT_KIND_UNAVAILABLE; groupBy on another kind -> DAT_PARAM_INVALID; document unchanged
 */
export const plantReport = defineCommand({
  name: 'plant_report',
  description:
    'Report on the plant objects as typed rows (pure, document unchanged). kind: line_list (one row per process line: line number, class, DN, fluid, spec, from, to, ' +
    'whether each end resolves, centreline length in m, straights, bends, design and operating conditions, hierarchy, unverified flag); equipment_list (tag, class, ' +
    'description, design conditions, size in m, OperatingWeightKg, hierarchy); nozzle_schedule (nozzles INFERRED where a line end lies inside the equipment its from / to ' +
    'names: N1, N2 per equipment in line creation order, DN of the line, SOURCE for the from end and SINK for the to end, inferred true); mto (material take-off: pipe in m ' +
    'and bends in ea from the centreline, grouped by groupBy, default spec, itemType, nominalSize; no take-outs are deducted, method is "centreline" and each row names its ' +
    'source lines); tag_register (every tag in scope with class, target kind, status modelled / reserved / orphan). valve_list, instrument_index and custom need sibling ' +
    'gaps and are refused with DAT_REPORT_KIND_UNAVAILABLE. hierarchy: only objects at that node or below (code, path S1/P1/U10 or id). format json (default): data only; ' +
    'csv or xlsx: also data.files = [{ fileName, content | base64 }] with ALL rows (save with --save), header "Name (unit)". Rows are sorted by tag in natural order. ' +
    'offset / limit page data.rows (limit at most 20000, default 2000); total counts all rows; totals sum the whole report. rowsByTag indexes the returned rows by their ' +
    'key (tag, or equipment/nozzle for nozzle_schedule) when keys are unique. Values flagged unverified are never hidden: the unverified column is true. ' +
    'Refusals: DAT_HIERARCHY_UNKNOWN, DAT_REPORT_KIND_UNAVAILABLE, DAT_PARAM_INVALID.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    confirmExportControlled,
    kind: z
      .enum(REPORT_KINDS)
      .describe(
        'Report kind: line_list, equipment_list, nozzle_schedule, mto, tag_register (built); valve_list, instrument_index, custom (refused for now).',
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
    const built = buildReport(doc, { kind: params.kind, hierarchy: params.hierarchy, groupBy: params.groupBy });
    if (!built.ok) return refuse(doc, 'plant_report', { code: built.code, message: built.message, paths: [built.path] });
    const { table } = built;
    const offset = params.offset ?? 0;
    const limit = params.limit ?? DEFAULT_LIMIT;
    const rows = table.rows.slice(offset, offset + limit);
    const fileStem = params.kind.replace(/_/g, '-');
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
      `plant_report ${params.kind}: ${table.rows.length} row(s)${params.hierarchy === undefined ? '' : ` under ${params.hierarchy}`}` +
        (Object.keys(table.totals).length === 0
          ? ''
          : ` (${Object.entries(table.totals)
              .map(([name, value]) => `${name} ${value}`)
              .join(', ')})`) +
        (files[0] === undefined ? '.' : `; file ${files[0].fileName}.`),
      {
        kind: params.kind,
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
