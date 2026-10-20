/**
 * Desktop crash reports (SC-D3), Electron-free: the main process's own crash report, and the text of Help > Crash Reports.
 * The backend writes its reports itself (server/src/serverCrash.ts) into the same folder. Nothing is sent: the issue draft is a link
 * the user may open.
 */
import fs from 'fs';
import { issueDraftUrl, listCrashReports, readCrashReport, writeCrashReport } from '@server/crashReports';

interface DesktopCrashOptions {
  readonly directory: string;
  /** The backend's autosave (the last state of the document the window showed); copied as the report's document. */
  readonly autosavePath: string;
  readonly appVersion: string;
}

/** Write a crash report for the desktop main process; null when it could not be written. */
export function writeDesktopCrashReport(error: unknown, options: DesktopCrashOptions): string | null {
  let documentJson: string | undefined;
  try {
    documentJson = fs.readFileSync(options.autosavePath, 'utf8');
  } catch {
    documentJson = undefined; // no autosave yet
  }
  return writeCrashReport(
    {
      source: 'desktop-main',
      error,
      appVersion: options.appVersion,
      ...(documentJson !== undefined ? { documentJson, commandLog: { replayFrom: 'document.llull.json', commands: [] } } : {}),
    },
    { directory: options.directory },
  );
}

interface CrashReportsView {
  readonly message: string;
  readonly detail: string;
  /** The newest report's GitHub issue draft; opened only when the user clicks. */
  readonly issueUrl: string | null;
}

/** Help > Crash Reports: how many reports, the newest one's error, and its issue draft link. */
export function crashReportsView(directory: string): CrashReportsView {
  const reports = listCrashReports(directory);
  const latest = readCrashReport(directory, 'latest');
  if (latest === null) return { message: 'No crash reports.', detail: `Crash reports are kept in ${directory}.`, issueUrl: null };
  const firstLines = latest.errorText.split(/\r?\n/).slice(0, 6).join('\n');
  return {
    message: `${reports.length} crash report${reports.length === 1 ? '' : 's'} (the last 20 are kept).`,
    detail: [
      `Latest: ${latest.id} (${latest.source})`,
      firstLines,
      '',
      'Each report folder holds the document, the command log that rebuilds it, and the error.',
      'Draft GitHub Issue opens a prefilled issue in your browser for you to review; nothing is sent automatically.',
      `Folder: ${directory}`,
    ].join('\n'),
    issueUrl: issueDraftUrl(latest),
  };
}
