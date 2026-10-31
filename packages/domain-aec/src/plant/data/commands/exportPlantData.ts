import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import { exportRefusal, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { xlsxSheetName } from '@lib/xlsxWrite';
import { csvFile, xlsxFile, xlsxSheetOf, type DataFile } from '../plantReports/files';
import { columnOf, type ReportColumn, type ReportRow } from '../plantReports/types';
import { buildDataTable, type TableColumn } from '../table';
import { refuse } from './params';

const KEY_COLUMN = 'id';
const DROPPED = new Set(['target', 'unverified']);
const MAX_CLASSES = 50;

const asReportColumn = (column: TableColumn): ReportColumn => ({
  ...columnOf(column.name, column.displayName, column.type, column.unit, 'property'),
  readOnly: column.readOnly,
});

/**
 * @affects none; data = { files: [{ fileName, base64 | content }], sheets: { <class>: { rows, columns } } }
 * @invariant one sheet per class (its subclasses included); ObjectId first and locked; read-only columns locked; identical input -> identical bytes
 * @failure controlled content without a human confirmation -> MAT_EXPORT_CONTROLLED / MAT_HUMAN_GATE; unknown class -> DAT_CLASS_UNKNOWN; unknown hierarchy node -> DAT_HIERARCHY_UNKNOWN; document unchanged
 */
export const exportPlantData = defineCommand({
  name: 'export_plant_data',
  description:
    'Export the properties of plant objects for editing in a spreadsheet (pure, document unchanged). classes: the classes to export; each becomes one sheet (xlsx) or one ' +
    'file (csv) holding the objects of that class and its subclasses. Columns: ObjectId (the key, locked), Tag, Class, Hierarchy (path), then one column per property of the ' +
    'classes headed "DisplayName (unit)", in the unit of the property definition. Tag, Class, Hierarchy, derived and read-only properties are locked (xlsx: sheet protection marks ' +
    'intent, it is not security); the others are unlocked. Rows are in natural tag order. hierarchy: only objects at that node or below (code, path S1/P1/U10 or id). ' +
    'format xlsx (default) gives one workbook plant-data.xlsx with a sheet per class; csv gives <class>.csv per class. includeReadOnly false drops the read-only columns ' +
    'except ObjectId. Returns data.files = [{ fileName, base64 | content }] (save with --save) and data.sheets = { <class>: { rows, columns [names] } }. ' +
    'Refusals: DAT_PARAM_INVALID (no class), DAT_CLASS_UNKNOWN, DAT_HIERARCHY_UNKNOWN.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    confirmExportControlled,
    classes: z
      .array(z.string())
      .max(MAX_CLASSES)
      .describe(
        'Names of the classes to export, e.g. ["Equipment"] (abstract classes export their subclasses). plant_data_table lists them.',
      ),
    hierarchy: z
      .string()
      .optional()
      .describe('Hierarchy node (code, path S1/P1/U10 or id) to restrict the export to; omit for the whole plant.'),
    format: z.enum(['xlsx', 'csv']).optional().describe('xlsx (default): one workbook, one sheet per class. csv: one file per class.'),
    includeReadOnly: z
      .boolean()
      .optional()
      .describe('Keep the read-only columns (default true). false keeps only ObjectId and the editable properties.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const gated = exportRefusal(doc, 'export_plant_data', 'data', params.confirmExportControlled, ctx);
    if (gated !== null) return gated;
    if (params.classes.length === 0)
      return refuse(doc, 'export_plant_data', {
        code: 'DAT_PARAM_INVALID',
        message: 'classes lists no class to export',
        paths: ['classes'],
      });
    const includeReadOnly = params.includeReadOnly !== false;
    const sheets: Record<string, { rows: number; columns: string[] }> = {};
    const tables: Array<{ name: string; columns: ReportColumn[]; rows: readonly ReportRow[] }> = [];
    for (const className of [...new Set(params.classes)]) {
      const table = buildDataTable(doc, {
        className,
        includeSubclasses: true,
        ...(params.hierarchy === undefined ? {} : { hierarchy: params.hierarchy }),
        filter: {},
        sort: [],
        offset: 0,
        limit: Number.MAX_SAFE_INTEGER,
      });
      if (!table.ok)
        return refuse(doc, 'export_plant_data', {
          code: table.code,
          message: table.message,
          paths: [table.path === 'className' ? 'classes' : table.path],
        });
      const columns = table.columns
        .filter((column) => !DROPPED.has(column.name) && (includeReadOnly || !column.readOnly || column.name === KEY_COLUMN))
        .map(asReportColumn);
      tables.push({ name: className, columns, rows: table.rows });
      sheets[className] = { rows: table.rows.length, columns: columns.map((column) => column.displayName) };
    }
    const format = params.format ?? 'xlsx';
    const names: string[] = [];
    const files: DataFile[] =
      format === 'csv'
        ? tables.map((table) => csvFile(`${xlsxSheetName(table.name, []).replace(/\s+/g, '_')}.csv`, table))
        : [
            xlsxFile(
              'plant-data.xlsx',
              tables.map((table) => {
                const name = xlsxSheetName(table.name, names);
                names.push(name);
                return xlsxSheetOf(name, table, true, (column) => !column.readOnly);
              }),
            ),
          ];
    const rowCount = tables.reduce((sum, table) => sum + table.rows.length, 0);
    return report(
      doc,
      `export_plant_data: ${rowCount} row(s) of ${tables.length} class(es) as ${format}; file ${files.map((file) => file.fileName).join(', ')}.`,
      { files, sheets },
    );
  },
});
