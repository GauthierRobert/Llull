import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { sha256Hex } from '@lib/sha256';
import { refusePid } from '../dexpi/codes';
import { mintId } from '../dexpi/proteusContext';
import { readDexpi } from '../dexpi/proteusRead';
import type { PidImportRecord, PidModel } from '../model';
import { censusCounts } from '../lists/counts';
import { getPid, withPid } from '../state';

/** First `PID-nnn` not used by a sheet. */
function freeSheetNumber(pid: PidModel): string {
  const used = new Set(Object.values(pid.sheets).map((sheet) => sheet.number));
  for (let n = 1; ; n++) {
    const number = `PID-${String(n).padStart(3, '0')}`;
    if (!used.has(number)) return number;
  }
}

/**
 * @affects plant.pid (one new sheet with the equipment, nozzles, lines, segments, inline components, instruments, loops, signals, actuating systems and off-page connectors of the file; one import record with sha256 and warnings)
 * @invariant all-or-nothing; only xmlRead reads the text (no DTD, no entity beyond the five predefined, no network, 50 MB / depth 256); a DEXPI 2.0 file is translated to the Proteus tree and mapped by the same code as 1.3, never fetching the model files it imports; coordinates are scaled to mm by PlantInformation Units; a DEXPI segment is split at its components, the pieces share passthrough dexpi:segment
 * @failure not well-formed / too large -> DEXPI_PARSE_ERROR (paths "line N, column M"); root neither PlantModel (SchemaVersion 4.1.x) nor a 2.x Model, or the requested version differs -> DEXPI_VERSION_UNSUPPORTED; a 2.0 file that breaks the schema rules -> DEXPI_SCHEMA_VIOLATION warnings (still imported); sheet number in use -> PID_SHEET_DUPLICATE; the document is unchanged
 */
export const importDexpi = defineCommand({
  name: 'import_dexpi',
  description:
    'Import a DEXPI P&ID as a new P&ID sheet of the document (doc.plant.pid): DEXPI 1.3 (Proteus XML, root <PlantModel>, PlantInformation SchemaVersion 4.1.x) or DEXPI 2.0 (root <Model> importing .../models/2.x.y/Plant.xml, Plant/PlantModel with its Core/Diagram; the imported model files are not fetched). Give the file text in `text` (CLI: file=<path>). ' +
    'All-or-nothing. Imported: Equipment (nested = sub-equipment) with Nozzles, PipingNetworkSystems as lines with line number / fluid / DN / piping class, PipingNetworkSegments (split at each PipingComponent: one ' +
    'segment between two items, all pieces of one DEXPI segment share passthrough "dexpi:segment"), PipingComponents (valves, tees, reducers ...), off-page connectors, flow arrows, instruments ' +
    '(tag = category + functions + number, e.g. "PICSA 4712.02"), loops, information flows as signals, actuating systems (on the valve they operate), and the generic attributes of every item. Sheet ' +
    'coordinates are millimetres (PlantInformation Units mm / cm / m / in / ft is scaled; a 2.0 diagram is in mm). Presentation (labels, text, shape catalogue) is not reproduced; a 2.0 file takes its placements, node positions and routes from the diagram. Returns data = { source: { dexpiVersion, schemaVersion, ' +
    'applicationVersion, originatingSystem, units, sha256, characters }, sheet: { id, number, title, paper }, itemCount, counts (the census of pid_report kind=counts), warnings: [{ code, severity, ' +
    'message, ids, paths, remediation }] }. Warnings (the file is still imported): DEXPI_DANGLING_REFERENCE (an end names no connectable object; imported as a free end), DEXPI_UNMAPPED_CLASS (imported ' +
    'as Custom, source class kept), DEXPI_ATTRIBUTE_UNIT (unknown unit kept as text, unverified), DEXPI_GRAPHICS_DROPPED (info), DEXPI_SCHEMA_VIOLATION (a 2.0 file breaks a rule of DEXPI_XML_Schema.xsd, paths give the place), DEXPI_SHEET_SIZE (a 2.0 border fits no sheet A4..A0: A1 is taken). Refusals (document unchanged): DEXPI_PARSE_ERROR (not well-formed XML, a DOCTYPE, ' +
    'too large or too deep; paths "line N, column M"), DEXPI_VERSION_UNSUPPORTED (other root, a 1.x/3.x Model, Proteus 4.2 / DEXPI 1.4, or the file is not the version asked for), PID_SHEET_DUPLICATE. Next: pid_report kind=counts / connectivity.',
  params: z.object({
    text: z.string().describe('The DEXPI Proteus XML file content (UTF-8 text). CLI: file=<path> fills it.'),
    version: z
      .enum(['auto', '1.3', '2.0'])
      .optional()
      .describe(
        'DEXPI version of the file. auto (default) tells it from the root (<PlantModel> = 1.3 with SchemaVersion 4.1.x, <Model> = 2.x); 1.3 or 2.0 refuse a file of the other version. 1.2 and 1.4 are not read.',
      ),
    sheet: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Number of the new sheet (unique, e.g. "PID-002"). Default: the first free PID-nnn.'),
  }),
  run: (doc, params): CommandResult => {
    const pid = getPid(doc);
    const number = params.sheet ?? freeSheetNumber(pid);
    if (Object.values(pid.sheets).some((sheet) => sheet.number === number))
      return refusePid(doc, 'import_dexpi', 'PID_SHEET_DUPLICATE', `a sheet numbered "${number}" exists`, [], ['sheet']);
    const sheetId = mintId();
    const read = readDexpi(params.text, sheetId, params.version ?? 'auto');
    if (!read.ok) return refusePid(doc, 'import_dexpi', read.code, read.message, [], read.paths, read.detail);
    const sha256 = sha256Hex(params.text);
    const record: PidImportRecord = {
      format: read.version === '2.0' ? 'dexpi-xml' : 'dexpi-proteus',
      version: read.version,
      sha256,
      warnings: read.issues.map((issue) => `${issue.code}: ${issue.message}`),
      sheetId,
      census: read.census,
    };
    const next: PidModel = {
      ...pid,
      sheets: { ...pid.sheets, [sheetId]: { id: sheetId, number, title: read.title, paper: read.paper, revision: '0', status: 'draft' } },
      sheetOrder: [...pid.sheetOrder, sheetId],
      items: { ...pid.items, ...read.items },
      itemOrder: [...pid.itemOrder, ...read.order],
      imports: [...(pid.imports ?? []), record],
    };
    const counts = censusCounts(next, sheetId);
    const warnings = read.issues.filter((issue) => issue.severity === 'warning').length;
    return {
      document: withPid(doc, next),
      summary:
        `import_dexpi: DEXPI ${read.version} read as sheet ${number} (${sheetId}): ${counts.equipmentAll} equipment, ${counts.nozzles} nozzles, ${counts.pipingNetworkSystems} lines in ` +
        `${counts.pipingNetworkSegments} segments, ${counts.pipingComponents} piping components, ${counts.processInstrumentationFunctions} instruments, ${counts.informationFlows} information flows ` +
        `(${read.order.length} items, ${warnings} warning(s))`,
      affected: [sheetId, ...read.order],
      data: {
        source: {
          dexpiVersion: read.version,
          schemaVersion: read.schemaVersion,
          applicationVersion: read.applicationVersion ?? null,
          originatingSystem: read.originatingSystem ?? null,
          units: read.units,
          sha256,
          characters: params.text.length,
        },
        sheet: { id: sheetId, number, title: read.title, paper: read.paper },
        itemCount: read.order.length,
        counts,
        warnings: read.issues,
      },
    };
  },
});
