import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { DEFINITION_KINDS, getPlantData, withPlantData, type ReportDefinition } from '../model';
import { buildReport } from '../plantReports/build';
import { applyDefinition } from '../plantReports/definition';
import { MTO_DIMENSIONS, type MtoDimension } from '../plantReports/mto';
import { refuse, scalarSchema } from './params';

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_DEFINITIONS = 500;

/**
 * @affects plant.data.reports[id] (+1, or replaced) as ONE step
 * @invariant the definition is checked against the report it describes (every column, filter and sort name exists, expressions parse and read existing columns); it stores choices, never rows
 * @failure bad id, unavailable kind, unknown column, bad expression, unknown hierarchy -> DAT_* refusal, document unchanged
 */
export const saveReportDefinition = defineCommand({
  name: 'save_report_definition',
  description:
    'Save a report template (a report definition) under an id, to run again with plant_report { definition: id } (also as a csv / xlsx file). kind is a built report kind ' +
    '(line_list, equipment_list, nozzle_schedule, mto, tag_register). Optional: hierarchy (node code / path), groupBy (mto), columns (the column names to keep, in order; ' +
    'plant_report lists the names in data.columns[].name), computed (extra columns evaluated per row with the parameter expression language over the numeric columns of the row, ' +
    'e.g. { name: "WeightT", displayName: "Weight", unit: "t", expression: "OperatingWeightKg / 1000" }; an operand that is empty gives an empty cell), filter ({ columnName: value }, rows ' +
    'whose column equals the value) and sort (column names, a leading - for descending). The definition is checked against the current report now: an unknown column or a bad expression ' +
    'is refused with DAT_COLUMN_UNKNOWN / DAT_PARAM_INVALID. An id that exists is replaced. Returns data = { id, replaced, columns [names] }. Next: plant_report.',
  params: z.object({
    id: z.string().describe('Definition id: a letter, then letters, digits, _ or - (at most 64), e.g. "weights-t".'),
    kind: z.enum(DEFINITION_KINDS).describe('The built report the definition customises.'),
    hierarchy: z.string().optional().describe('Hierarchy node (code, path S1/P1/U10 or id) to restrict the report to.'),
    groupBy: z
      .array(z.enum(MTO_DIMENSIONS))
      .min(1)
      .optional()
      .describe('mto only: dimensions to group by (spec, itemType, nominalSize, line, hierarchy).'),
    columns: z
      .array(z.string())
      .min(1)
      .max(200)
      .optional()
      .describe('Column names to keep, in this order (computed columns included). Default all.'),
    computed: z
      .array(
        z.object({
          name: z
            .string()
            .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
            .describe('Column name (an identifier) other expressions and columns / filter / sort refer to.'),
          displayName: z.string().min(1).describe('Header text of the column.'),
          expression: z
            .string()
            .min(1)
            .max(500)
            .describe(
              'Expression over the numeric columns of the row, e.g. "OperatingWeightKg / 1000". + - * / ( ) and functions such as sqrt, round, min, max.',
            ),
          unit: z
            .string()
            .optional()
            .describe('Unit text printed in the header, e.g. "t". Informational: the expression decides the number.'),
        }),
      )
      .max(20)
      .optional()
      .describe('Extra columns computed per row.'),
    filter: z
      .record(z.string(), scalarSchema)
      .optional()
      .describe('Keep the rows whose column equals the value, e.g. { "className": "Tank" }.'),
    sort: z.array(z.string()).max(10).optional().describe('Column names to sort by after the natural tag order, "-name" for descending.'),
  }),
  run: (doc, params): CommandResult => {
    if (!ID.test(params.id))
      return refuse(doc, 'save_report_definition', {
        code: 'DAT_PARAM_INVALID',
        message: `id "${params.id.slice(0, 80)}" must start with a letter and use letters, digits, _ or - (at most 64 characters)`,
        paths: ['id'],
      });
    const data = getPlantData(doc);
    const existing = data.reports?.[params.id];
    if (existing === undefined && Object.keys(data.reports ?? {}).length >= MAX_DEFINITIONS)
      return refuse(doc, 'save_report_definition', {
        code: 'DAT_PARAM_INVALID',
        message: `at most ${MAX_DEFINITIONS} report definitions`,
        paths: ['id'],
      });
    const definition: ReportDefinition = {
      id: params.id,
      kind: params.kind,
      ...(params.hierarchy === undefined ? {} : { hierarchy: params.hierarchy }),
      ...(params.groupBy === undefined ? {} : { groupBy: params.groupBy }),
      ...(params.columns === undefined ? {} : { columns: params.columns }),
      ...(params.computed === undefined ? {} : { computed: params.computed.map((entry) => ({ ...entry, unit: entry.unit ?? null })) }),
      ...(params.filter === undefined ? {} : { filter: params.filter }),
      ...(params.sort === undefined ? {} : { sort: params.sort }),
    };
    const built = buildReport(doc, {
      kind: definition.kind,
      hierarchy: definition.hierarchy,
      groupBy: definition.groupBy as MtoDimension[] | undefined,
    });
    if (!built.ok) return refuse(doc, 'save_report_definition', { code: built.code, message: built.message, paths: [built.path] });
    const applied = applyDefinition(built.table, definition);
    if (!applied.ok) return refuse(doc, 'save_report_definition', { code: applied.code, message: applied.message, paths: [applied.path] });
    const next = withPlantData(doc, { ...data, reports: { ...data.reports, [definition.id]: definition } });
    return {
      ...changed(
        next,
        `save_report_definition: ${existing === undefined ? 'saved' : 'replaced'} ${definition.id} (${definition.kind}, ${applied.table.columns.length} column(s)).`,
        [],
      ),
      data: { id: definition.id, replaced: existing !== undefined, columns: applied.table.columns.map((column) => column.name) },
    };
  },
});
