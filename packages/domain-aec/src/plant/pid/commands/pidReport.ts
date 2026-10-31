import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { toCsv } from '@lib/csv';
import { refusePid } from '../dexpi/codes';
import { getPid } from '../state';
import { COUNT_KEYS, censusCounts } from '../lists/counts';
import { CONNECTIVITY_COLUMNS, connectivity } from '../lists/connectivity';

/**
 * @affects nothing (read-only query of `doc.plant.pid`)
 * @invariant counts apply the counting rules of validation/data/dexpi_census.json (segments folded per DEXPI segment, valves by source class); rows keep model (import) order
 * @failure sheet (number or id) not found -> PID_SHEET_NOT_FOUND; a document without a P&ID answers with zero counts / no rows, never an error
 */
export const pidReport = defineCommand({
  name: 'pid_report',
  description:
    'Report on the P&ID of the document (doc.plant.pid), read-only. kind=counts returns the census of the model: equipmentTopLevel, equipmentAll (sub-equipment included), nozzles, pipingNetworkSystems (lines), ' +
    'pipingNetworkSegments (DEXPI segments), pipingComponents, valves (component class contains "Valve"), processInstrumentationFunctions, instrumentationLoopFunctions, actuatingSystems, ' +
    'processSignalGeneratingFunctions, informationFlows, pipeOffPageConnectors, pipeFlowArrows, and the import counters connections, danglingConnections, shapeCatalogueEntries (summed over the imports; ' +
    'import_dexpi records them). kind=connectivity returns the connection graph, one row per DEXPI segment (via=segment, with its line number) and one per information flow (via=information_flow): ' +
    'from / to are "<equipment tag>/<nozzle sub-tag>", a component or instrument tag (or its file id), "OPC:<pairKey>" or "free"; fromType / toType are "<DEXPI element>:<class>" or "open"; summary lists ' +
    'nozzlesUnconnected and the endpoint-type histogram. Returns data = { kind, columns, rows, csv, counts | summary }. `sheet` limits the report to one sheet. Refusal: PID_SHEET_NOT_FOUND. ' +
    'Next: import_dexpi creates the model this reports on.',
  params: z.object({
    kind: z
      .enum(['counts', 'connectivity'])
      .describe(
        'counts = object census (data.counts, rows key/value); connectivity = connection rows and summary. Further kinds (line_list, valve_list, ...) arrive with plant 04 M4.',
      ),
    sheet: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Report only this sheet: its number (e.g. "PID-001") or its id. Omit for the whole P&ID.'),
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
    if (params.kind === 'counts') {
      const counts = censusCounts(pid, sheet?.id);
      const rows = COUNT_KEYS.map((key) => ({ key, value: counts[key] }));
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
    const { rows, summary } = connectivity(pid, sheet?.id);
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
  },
});
