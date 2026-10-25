import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { getPlantData } from '../model';
import { buildDataTable } from '../table';
import { refuse, scalarSchema } from './params';

const DEFAULT_LIMIT = 200;

/**
 * @affects none; data = { columns, rows, total, offset, limit, classes? }
 * @invariant rows sorted by natural tag order unless sort says otherwise (P-2 before P-10); identical input -> identical output
 * @failure unknown class / hierarchy node / column -> DAT_CLASS_UNKNOWN, DAT_HIERARCHY_UNKNOWN, DAT_COLUMN_UNKNOWN
 */
export const plantDataTable = defineCommand({
  name: 'plant_data_table',
  description:
    'Read the plant objects as a table (the Data Manager grid): one row per object with the columns id, tag, className, hierarchy (path), target (the model ' +
    'object), unverified (properties flagged unverified) and then the properties of the class with their type and unit. className: rows of that class ' +
    '(includeSubclasses, default true, adds its subclasses); omit it to list every object and get data.classes (name, parent, abstract, source, object count). ' +
    'hierarchy: only objects at that node or below (code, path S1/P1/U10 or id). columns: the columns to return (default all). filter: { column: value } ' +
    'equality tests. sort: column names, "-name" for descending (default the tag in natural order, P-2 before P-10). offset / limit page the rows (limit at most 2000, ' +
    'default 200); total counts all matches. Returns data = { columns [{ name, displayName, type, unit, readOnly }], rows, total, offset, limit, classes? }. ' +
    'Refusals: DAT_CLASS_UNKNOWN, DAT_HIERARCHY_UNKNOWN, DAT_COLUMN_UNKNOWN.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    className: z.string().optional().describe('Class whose objects to list; omit for all.'),
    includeSubclasses: z.boolean().optional().describe('Include objects of subclasses (default true).'),
    hierarchy: z.string().optional().describe('Hierarchy node (code, path or id) to restrict to.'),
    columns: z.array(z.string()).optional().describe('Column names to return, in this order; default all.'),
    filter: z.record(z.string(), scalarSchema).optional().describe('Column -> value equality filters, e.g. { "Service": "feed" }.'),
    sort: z.array(z.string()).optional().describe('Column names to sort by; prefix "-" for descending. Default: tag in natural order.'),
    offset: z.number().int().min(0).optional().describe('Rows to skip (paging). Default 0.'),
    limit: z.number().int().min(1).max(2000).optional().describe('Rows to return, 1-2000. Default 200.'),
  }),
  run: (doc, params): CommandResult => {
    const offset = params.offset ?? 0;
    const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_LIMIT), 2000);
    const table = buildDataTable(doc, {
      ...(params.className === undefined ? {} : { className: params.className }),
      includeSubclasses: params.includeSubclasses !== false,
      ...(params.hierarchy === undefined ? {} : { hierarchy: params.hierarchy }),
      ...(params.columns === undefined ? {} : { columns: params.columns }),
      filter: params.filter ?? {},
      sort: params.sort ?? [],
      offset,
      limit,
    });
    if (!table.ok) return refuse(doc, 'plant_data_table', { code: table.code, message: table.message, paths: [table.path] });
    const data = getPlantData(doc);
    const classes =
      params.className !== undefined
        ? undefined
        : data.classOrder.map((name) => {
            const cls = data.classes[name];
            return {
              name,
              parent: cls?.parent ?? null,
              abstract: cls?.abstract ?? false,
              source: cls?.source ?? 'project',
              objects: data.objectOrder.filter((id) => data.objects[id]?.className === name).length,
            };
          });
    return report(
      doc,
      `plant_data_table: ${table.rows.length} of ${table.total} row(s)${params.className === undefined ? '' : ` of ${params.className}`}, ${table.columns.length} column(s).`,
      { columns: table.columns, rows: table.rows, total: table.total, offset, limit, ...(classes === undefined ? {} : { classes }) },
    );
  },
});
