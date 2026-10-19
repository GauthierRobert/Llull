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
import { withoutConfirmations } from '@lib/withoutConfirmations';

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

/** A command that keeps throwing (an agent retrying in a loop) must not fill the disk or stall the bus with report writes. */
const PER_COMMAND_INTERVAL_MS = 60_000;
const MAX_COMMAND_REPORTS_PER_MINUTE = 5;
const lastReportByCommand = new Map<string, number>();
let recentCommandReports: number[] = [];

/** May a `command-threw` report for `name` be written at `now`? Records it when yes. */
function commandReportAllowed(name: string, now: number): boolean {
  const last = lastReportByCommand.get(name);
  if (last !== undefined && now - last < PER_COMMAND_INTERVAL_MS) return false;
  recentCommandReports = recentCommandReports.filter((time) => now - time < 60_000);
  if (recentCommandReports.length >= MAX_COMMAND_REPORTS_PER_MINUTE) return false;
  lastReportByCommand.set(name, now);
  recentCommandReports.push(now);
  return true;
}

/** @internal tests only */
export function _resetCrashRateLimit(): void {
  lastReportByCommand.clear();
  recentCommandReports = [];
}

/**
 * Write a crash report for the backend; returns its directory (null when it could not be written or was rate-limited).
 * @param failing the command that threw: the report's document is the one it ran on, and `commands.json` ends with it; at most one
 *   report per command name per minute and 5 per minute overall (fatal errors are never limited)
 */
export function reportServerCrash(source: CrashSource, error: unknown, failing?: FailingCommand, now: number = Date.now()): string | null {
  try {
    if (failing !== undefined && !commandReportAllowed(failing.name, now)) return null;
    const { base, commands } = liveCommandLog();
    const baseJson = serializedOrUndefined(base);
    const fromEmpty = baseJson === EMPTY_DOCUMENT_JSON;
    const commandLog: CrashCommandLog = {
      replayFrom: fromEmpty ? 'empty' : 'base.llull.json',
      commands,
      ...(failing !== undefined ? { failing: { name: failing.name, params: withoutConfirmations(failing.params) } } : {}),
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
