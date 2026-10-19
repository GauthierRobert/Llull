/**
 * Backend crash reports (SC-D3): the live document, the command log that rebuilds it, the error. Glue only; the format is in
 * crashReports.ts. Directory: `$LLULL_DATA_DIR` or the platform data dir (`crashReportsDir`).
 */
import type { CadDocument } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { crashReportsDir, writeCrashReport, type CrashCommandLog, type CrashSource, type LoggedCommand } from './crashReports';
import { getLiveDoc } from './liveDocument';
import { liveCommandLog } from './liveCommandLog';

const EMPTY_DOCUMENT_JSON = serializeDocument(createEmptyDocument());

function serializedOrUndefined(doc: CadDocument): string | undefined {
  try {
    return serializeDocument(doc);
  } catch {
    return undefined; // the report still carries the error and the command log
  }
}

interface FailingCommand extends LoggedCommand {
  /** The document the command ran on (the live document then). */
  readonly document: CadDocument;
}

/**
 * Write a crash report for the backend; returns its directory (null when it could not be written).
 * @param failing the command that threw: the report's document is the one it ran on, and `commands.json` ends with it
 */
export function reportServerCrash(source: CrashSource, error: unknown, failing?: FailingCommand): string | null {
  try {
    const { base, commands } = liveCommandLog();
    const baseJson = serializedOrUndefined(base);
    const fromEmpty = baseJson === EMPTY_DOCUMENT_JSON;
    const commandLog: CrashCommandLog = {
      replayFrom: fromEmpty ? 'empty' : 'base.llull.json',
      commands,
      ...(failing !== undefined ? { failing: { name: failing.name, params: failing.params } } : {}),
    };
    const documentJson = serializedOrUndefined(failing?.document ?? getLiveDoc());
    return writeCrashReport(
      {
        source,
        error,
        commandLog,
        ...(documentJson !== undefined ? { documentJson } : {}),
        ...(!fromEmpty && baseJson !== undefined ? { baseDocumentJson: baseJson } : {}),
      },
      { directory: crashReportsDir(process.env) },
    );
  } catch {
    return null;
  }
}
