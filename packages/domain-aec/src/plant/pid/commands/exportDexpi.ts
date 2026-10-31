import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { exportRefusal, report } from '@core/commands/noop';
import { refusePid } from '../dexpi/codes';
import { buildDexpi } from '../export/exportDexpi';
import { getPid } from '../state';

/**
 * @affects nothing (read-only query of `doc.plant.pid`; the file is in `data.text`)
 * @invariant deterministic (same model, same bytes; export -> import -> export is a fixed point); every text is escaped; ids are the source ids of an import, else <Class>-<n>; DEXPI segments are rebuilt by folding the pieces llull split them into; coordinates are sheet mm (Units="mm")
 * @failure no sheet / unknown sheet -> PID_SHEET_NOT_FOUND; output over 50 million characters -> PID_EXPORT_TOO_LARGE; export-controlled content without confirmation -> MAT_EXPORT_CONTROLLED; the document is unchanged
 */
export const exportDexpi = defineCommand({
  name: 'export_dexpi',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Export the P&ID of the document (doc.plant.pid) as DEXPI 1.3 Proteus XML (root <PlantModel>, SchemaVersion 4.1.1, Units mm), read-only, deterministic: the same document gives the same bytes. ' +
    'Written: Equipment (sub-equipment nested) with Nozzles, PipingNetworkSystems (lines) with PipingNetworkSegments rebuilt from the pieces llull split them into (components, centre lines, off-page connectors, flow arrows and one Connection), ' +
    'instruments with their signal generating functions, loops, information flows, actuating systems, annotations, the generic attributes of every item (typed fields such as tag, line number, DN, piping class are written as DEXPI attributes) and a Drawing extent from the paper size. ' +
    'Importing the file again (import_dexpi) gives the same pid_report counts and connectivity; exported ids are the source ids of an import, else <Class>-<n>. Not written: shape catalogue, labels and text (shapeCatalogueEntries is 0), the original dangling references, ' +
    'sheet boundaries (all exported sheets share one PlantModel and one Drawing, named after the first), defaulted/unverified flags, reverse flow (written source-to-target, comes back as forward) and the target sheet of an off-page connector beyond its number. ' +
    'Returns data = { text, version, sha256, sheets: [numbers], counts (the pid_report census of the file as written), warnings: [{ code, severity, message, ids, paths, remediation }] }; save with `llull export_dexpi --save out.xml`. ' +
    'Refusals (document unchanged): PID_SHEET_NOT_FOUND, PID_EXPORT_TOO_LARGE, MAT_EXPORT_CONTROLLED. Next: import_dexpi reads it back; export_pid_svg draws the sheet.',
  params: z.object({
    version: z
      .enum(['1.3'])
      .describe('DEXPI version to write. Only 1.3 (Proteus 4.1.1) is offered; 1.4 and 2.0 arrive with later milestones.'),
    sheets: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(1000)
      .optional()
      .describe('Sheets to export: numbers (e.g. "PID-001") or ids. Default: every sheet, merged into one PlantModel.'),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_dexpi', 'data', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const pid = getPid(doc);
    if (pid.sheetOrder.length === 0)
      return refusePid(doc, 'export_dexpi', 'PID_SHEET_NOT_FOUND', 'the document has no P&ID sheet', [], ['sheets']);
    const wanted = params.sheets?.map((name) => pid.sheets[name] ?? Object.values(pid.sheets).find((sheet) => sheet.number === name));
    const missing = params.sheets?.filter((_, index) => wanted?.[index] === undefined);
    if (missing !== undefined && missing.length > 0)
      return refusePid(
        doc,
        'export_dexpi',
        'PID_SHEET_NOT_FOUND',
        `no sheet ${missing.map((name) => `"${name}"`).join(', ')}`,
        [],
        ['sheets'],
      );
    const written = buildDexpi(
      pid,
      wanted?.flatMap((sheet) => (sheet === undefined ? [] : [sheet.id])),
    );
    if (!written.ok)
      return refusePid(
        doc,
        'export_dexpi',
        'PID_EXPORT_TOO_LARGE',
        `the file would have ${written.characters} characters (limit 50000000)`,
        [],
        ['sheets'],
      );
    const { counts } = written;
    return report(
      doc,
      `export_dexpi: DEXPI 1.3 of ${written.sheets.join(', ')}: ${counts.equipmentAll} equipment, ${counts.nozzles} nozzles, ${counts.pipingNetworkSystems} lines in ${counts.pipingNetworkSegments} segments, ` +
        `${counts.pipingComponents} piping components, ${counts.processInstrumentationFunctions} instruments, ${counts.informationFlows} information flows, ${written.text.length} characters (sha256 ${written.sha256.slice(0, 12)}), ${written.warnings.filter((w) => w.severity === 'warning').length} warning(s)`,
      { text: written.text, version: '1.3', sha256: written.sha256, sheets: written.sheets, counts, warnings: written.warnings },
    );
  },
});
