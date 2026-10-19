/** `llull crashes list | show <id|latest> | dir`: the local crash reports (SC-D3). Read-only; nothing is sent anywhere. */
import { crashReportsDir, issueDraftUrl, listCrashReports, readCrashReport } from '../crashReports';

interface CrashesIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly json: boolean;
}

const CRASHES_USAGE = 'usage: llull crashes list | show <id|latest> | dir';

/** Exit code: 0 ok, 1 no such report, 2 bad usage. */
export function crashesCli(args: readonly string[], io: CrashesIo): number {
  const directory = crashReportsDir(io.env);
  const [action = 'list', id] = args;
  switch (action) {
    case 'dir':
      io.stdout(io.json ? JSON.stringify({ directory }) : directory);
      return 0;
    case 'list': {
      const reports = listCrashReports(directory);
      if (io.json) io.stdout(JSON.stringify({ directory, reports }));
      else if (reports.length === 0) io.stdout(`No crash reports in ${directory}.`);
      else io.stdout(reports.map((report) => `${report.id}  ${report.source.padEnd(26)}  ${report.message}`).join('\n'));
      return 0;
    }
    case 'show': {
      if (id === undefined) {
        io.stderr(`llull: ${CRASHES_USAGE}`);
        return 2;
      }
      const report = readCrashReport(directory, id);
      if (report === null) {
        io.stderr(`llull: no crash report '${id}' in ${directory} (llull crashes list).`);
        return 1;
      }
      const issueUrl = issueDraftUrl(report);
      if (io.json) {
        io.stdout(JSON.stringify({ ...report, issueUrl }));
        return 0;
      }
      io.stdout(
        [
          `${report.id}  (${report.source}, ${report.time})`,
          `folder: ${report.directory}`,
          `files:  ${report.files.join(', ')}`,
          '',
          report.errorText.trimEnd(),
          '',
          'document.llull.json is the document when it crashed; commands.json replays it from its replayFrom document, then the failing command.',
          'Issue draft (nothing is sent; review it in the browser, attach the files only if you can share your model):',
          issueUrl,
        ].join('\n'),
      );
      return 0;
    }
    default:
      io.stderr(`llull: unknown crashes action '${action}'. ${CRASHES_USAGE}`);
      return 2;
  }
}
