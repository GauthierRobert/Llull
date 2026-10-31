import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { toCsv } from '@lib/csv';
import { refusePid } from '../dexpi/codes';
import type { PidModel } from '../model';
import { getPid } from '../state';
import { COUNT_KEYS, censusCounts } from '../lists/counts';
import { CONNECTIVITY_COLUMNS, connectivity } from '../lists/connectivity';
import { equipmentList, nozzleList } from '../lists/equipmentList';
import { instrumentIndex } from '../lists/instrumentIndex';
import { lineList } from '../lists/lineList';
import type { ListResult } from '../lists/lookup';
import { valveList } from '../lists/valveList';

const KINDS = ['counts', 'connectivity', 'line_list', 'valve_list', 'instrument_index', 'equipment_list', 'nozzle_list'] as const;

const LISTS: Readonly<
  Record<
    'line_list' | 'valve_list' | 'instrument_index' | 'equipment_list' | 'nozzle_list',
    (pid: PidModel, sheetId?: string) => ListResult
  >
> = {
  line_list: lineList,
  valve_list: valveList,
  instrument_index: instrumentIndex,
  equipment_list: equipmentList,
  nozzle_list: nozzleList,
};

/** Rows whose every filtered column contains the text (case-insensitive). */
const matches = (row: object, filter: Readonly<Record<string, string>>): boolean =>
  Object.entries(filter).every(([column, text]) =>
    String((row as Record<string, unknown>)[column] ?? '')
      .toLowerCase()
      .includes(text.toLowerCase()),
  );

/**
 * @affects nothing (read-only query of `doc.plant.pid`)
 * @invariant counts apply the counting rules of validation/data/dexpi_census.json (segments folded per DEXPI segment, valves by source class); connectivity rows keep model (import) order; the five lists are sorted by natural tag / line number, ties by id, with fixed CSV columns
 * @failure sheet (number or id) not found -> PID_SHEET_NOT_FOUND; filter column not in the report -> PID_PARAM_INVALID; a document without a P&ID answers with zero counts / no rows, never an error
 */
export const pidReport = defineCommand({
  name: 'pid_report',
  description:
    'Report on the P&ID of the document (doc.plant.pid), read-only. kind=counts returns the census of the model: equipmentTopLevel, equipmentAll (sub-equipment included), nozzles, pipingNetworkSystems (lines), ' +
    'pipingNetworkSegments (DEXPI segments), pipingComponents, valves (component class contains "Valve"), processInstrumentationFunctions, instrumentationLoopFunctions, actuatingSystems, ' +
    'processSignalGeneratingFunctions, informationFlows, pipeOffPageConnectors, pipeFlowArrows, and the import counters connections, danglingConnections, shapeCatalogueEntries (summed over the imports; ' +
    'import_dexpi records them). kind=connectivity returns the connection graph, one row per DEXPI segment (via=segment, with its line number) and one per information flow (via=information_flow): ' +
    'from / to are "<equipment tag>/<nozzle sub-tag>", a component or instrument tag (or its file id), "OPC:<pairKey>" or "free"; fromType / toType are "<DEXPI element>:<class>" or "open"; summary lists ' +
    'nozzlesUnconnected and the endpoint-type histogram. The five lists, sorted by natural tag (ties by id), each with a fixed CSV header: line_list (lineNumber, sheet, dn, pipingClass, fluidCode, from, to, segments = stored segments of the line, insulation, inlineTags), ' +
    'valve_list (tag, class, lineNumber, dn, pipingClass, actuated, failAction, sheet), instrument_index (tag, category, functions, loop, location, display, measuredLine, controls, sheet), ' +
    'equipment_list (top-level equipment: tag, class, nozzles, designPressure, designTemperature, sheet), nozzle_list (equipmentTag, subTag, dn, connectedLine, access); an item without a tag shows its id in the source file. ' +
    'Returns data = { kind, columns, rows, csv, counts | summary }. `sheet` limits the report to one sheet; `filter` keeps the rows whose columns contain the given texts. Refusals: PID_SHEET_NOT_FOUND, PID_PARAM_INVALID (unknown filter column). ' +
    'Next: import_dexpi or the add_pid_* commands create the model this reports on; check_pid checks it.',
  params: z.object({
    kind: z
      .enum(KINDS)
      .describe(
        'counts = object census (data.counts, rows key/value); connectivity = connection rows and summary; line_list, valve_list, instrument_index, equipment_list, nozzle_list = the P&ID lists (data.rows, data.csv).',
      ),
    sheet: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Report only this sheet: its number (e.g. "PID-001") or its id. Omit for the whole P&ID.'),
    filter: z
      .record(z.string().min(1), z.string())
      .optional()
      .describe(
        'Keep only the rows whose columns contain these texts, case-insensitive, all must match: column name -> text (e.g. {"dn": "50", "pipingClass": "A1"}). Column names are those of the report (data.columns).',
      ),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, params): CommandResult => {
    const pid = getPid(doc);
    const sheet =
      params.sheet === undefined
        ? undefined
        : (pid.sheets[params.sheet] ?? Object.values(pid.sheets).find((s) => s.number === params.sheet));
    if (params.sheet !== undefined && sheet === undefined)
      return refusePid(doc, 'pid_report', 'PID_SHEET_NOT_FOUND', `no sheet "${params.sheet}"`, [], ['sheet']);
    const filter = params.filter ?? {};
    const refuseFilter = (columns: readonly string[]): CommandResult | undefined => {
      const unknown = Object.keys(filter).find((column) => !columns.includes(column));
      return unknown === undefined
        ? undefined
        : refusePid(
            doc,
            'pid_report',
            'PID_PARAM_INVALID',
            `filter column "${unknown}" is not in ${params.kind} (${columns.join(', ')})`,
            [],
            ['filter'],
          );
    };
    if (params.kind === 'counts') {
      const refused = refuseFilter(['key', 'value']);
      if (refused !== undefined) return refused;
      const counts = censusCounts(pid, sheet?.id);
      const rows = COUNT_KEYS.map((key) => ({ key, value: counts[key] })).filter((row) => matches(row, filter));
      const csv = toCsv(
        ['key', 'value'],
        rows.map((row) => [row.key, row.value]),
      );
      return report(
        doc,
        `pid_report counts: ${counts.equipmentAll} equipment, ${counts.nozzles} nozzles, ${counts.pipingNetworkSystems} lines in ${counts.pipingNetworkSegments} segments, ` +
          `${counts.pipingComponents} piping components (${counts.valves} valves), ${counts.processInstrumentationFunctions} instruments, ${counts.informationFlows} information flows`,
        { kind: 'counts', columns: ['key', 'value'], rows, csv, counts },
      );
    }
    if (params.kind === 'connectivity') {
      const refused = refuseFilter(CONNECTIVITY_COLUMNS);
      if (refused !== undefined) return refused;
      const { rows: all, summary } = connectivity(pid, sheet?.id);
      const rows = all.filter((row) => matches(row, filter));
      const csv = toCsv(
        CONNECTIVITY_COLUMNS,
        rows.map((row) => CONNECTIVITY_COLUMNS.map((column) => row[column])),
      );
      return report(
        doc,
        `pid_report connectivity: ${summary.processConnections} process + ${summary.informationConnections} information connections, ${summary.nozzlesConnected} of ${summary.nozzlesTotal} nozzles connected` +
          (summary.nozzlesUnconnected.length === 0 ? '' : ` (unconnected: ${summary.nozzlesUnconnected.join(', ')})`),
        { kind: 'connectivity', columns: [...CONNECTIVITY_COLUMNS], rows, csv, summary },
      );
    }
    const list = LISTS[params.kind](pid, sheet?.id);
    const refused = refuseFilter(list.columns);
    if (refused !== undefined) return refused;
    const rows = list.rows.filter((row) => matches(row, filter));
    const csv = toCsv(
      list.columns,
      rows.map((row) => list.columns.map((column) => row[column] ?? null)),
    );
    return report(
      doc,
      `pid_report ${params.kind}: ${rows.length} rows${rows.length === list.rows.length ? '' : ` of ${list.rows.length} (filtered)`}`,
      { kind: params.kind, columns: [...list.columns], rows, csv },
    );
  },
});
