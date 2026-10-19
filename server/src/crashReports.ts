/**
 * Local crash reports (SC-D3): `<data dir>/llull/crashes/<id>/` with
 *   document.llull.json  the document when it crashed (a llull-document file `llull --doc` / File > Open load)
 *   commands.json        { replayFrom, commands, failing? }: the command log that rebuilds the document from `replayFrom`
 *                        ('empty' or 'base.llull.json', written next to it), then the command that threw
 *   error.txt            message + stack (home directory replaced by ~)
 *   meta.json            versions, platform, source; no personal data, no environment
 * Nothing leaves the machine: `issueDraftUrl` builds a GitHub "new issue" link the user may choose to open (AF-41).
 * Shared by the backend, the CLI (`llull crashes`) and the desktop main process; every writer here is best effort and never throws.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export type CrashSource = 'server-uncaught-exception' | 'server-unhandled-rejection' | 'command-threw' | 'desktop-main';

export interface LoggedCommand {
  readonly name: string;
  readonly params: unknown;
}

export interface CrashCommandLog {
  /** 'empty' = an empty document; else a file name inside the report. */
  readonly replayFrom: 'empty' | 'base.llull.json' | 'document.llull.json';
  readonly commands: readonly LoggedCommand[];
  /** The command that threw (re-running it on the replayed document reproduces the crash). */
  readonly failing?: LoggedCommand;
}

export interface CrashReportInput {
  readonly source: CrashSource;
  readonly error: unknown;
  readonly documentJson?: string;
  readonly baseDocumentJson?: string;
  readonly commandLog?: CrashCommandLog;
  readonly appVersion?: string;
}

interface CrashMeta {
  readonly schema: 1;
  readonly id: string;
  readonly time: string;
  readonly source: CrashSource;
  readonly appVersion: string;
  readonly versions: Readonly<Record<string, string>>;
  readonly platform: string;
  readonly arch: string;
  readonly osRelease: string;
  readonly failingCommand?: string;
  readonly loggedCommands: number;
  readonly hasDocument: boolean;
}

export interface CrashReportSummary {
  readonly id: string;
  readonly time: string;
  readonly source: string;
  readonly message: string;
}

export interface CrashReport extends CrashReportSummary {
  readonly directory: string;
  readonly errorText: string;
  readonly meta: Record<string, unknown>;
  readonly files: readonly string[];
}

const DEFAULT_KEEP = 20;
const REPORT_ID = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z(?:-\d+)?$/;
const ISSUES_URL = 'https://github.com/GauthierRobert/Llull/issues/new';
const MAX_ISSUE_ERROR_CHARS = 3000;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The per-user data directory: `$LLULL_DATA_DIR` (tests), else %LOCALAPPDATA% (Windows), ~/Library/Application Support (macOS),
 * `$XDG_DATA_HOME` or ~/.local/share (Linux and others).
 */
function userDataDir(env: Env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  const override = env['LLULL_DATA_DIR'];
  if (override !== undefined && override !== '') return override;
  if (platform === 'win32') return env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  const xdg = env['XDG_DATA_HOME'];
  return xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'share');
}

export function crashReportsDir(env: Env, platform?: NodeJS.Platform, home?: string): string {
  return path.join(userDataDir(env, platform, home), 'llull', 'crashes');
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `text` with the user's home directory (a user name, usually) replaced by `~`: both slash spellings, JSON-escaped backslashes and the
 * URL-encoded form (file:/// URLs, `%20` for a space); case-insensitive on Windows (`c:\users\…` = `C:\Users\…`).
 */
export function redactHome(text: string, home: string = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  if (home.length < 2) return text;
  const forward = home.replace(/\\/g, '/');
  const back = home.replace(/\//g, '\\');
  const variants = [...new Set([back.replace(/\\/g, '\\\\'), back, forward, encodeURI(forward), encodeURI(back)])].sort(
    (a, b) => b.length - a.length,
  );
  const pattern = new RegExp(variants.map(escapeRegExp).join('|'), platform === 'win32' ? 'gi' : 'g');
  return text.replace(pattern, '~');
}

const MAX_REDACTION_DEPTH = 256;

/** Every string inside `value` (keys included) passed through `redactHome`; deeper than any params a command accepts -> a marker. */
function redactStrings(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactHome(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_REDACTION_DEPTH) return '[nested too deep]';
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactHome(key), redactStrings(item, depth + 1)]));
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const stack = error.stack ?? '';
    const headline = `${error.name}: ${error.message}`;
    return redactHome(stack.startsWith(headline) ? stack : `${headline}\n${stack}`);
  }
  try {
    return redactHome(`Non-Error thrown: ${typeof error === 'string' ? error : JSON.stringify(error)}`);
  } catch {
    return `Non-Error thrown: ${String(error)}`;
  }
}

function serverVersion(): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function freeReportId(directory: string, now: number): string {
  const base = new Date(now).toISOString().replace(/:/g, '-');
  let id = base;
  for (let n = 2; fs.existsSync(path.join(directory, id)); n++) id = `${base}-${n}`;
  return id;
}

/** Keep the newest `keep` reports; never touches anything that is not a report directory. */
function pruneCrashReports(directory: string, keep: number = DEFAULT_KEEP): void {
  const ids = reportIds(directory);
  for (const id of ids.slice(0, Math.max(0, ids.length - keep))) fs.rmSync(path.join(directory, id), { recursive: true, force: true });
}

function reportIds(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => REPORT_ID.test(name))
      .sort();
  } catch {
    return [];
  }
}

interface WriteOptions {
  readonly directory: string;
  readonly now?: number;
  readonly keep?: number;
}

/**
 * Write one report (staged in `<id>.partial`, renamed when complete) and prune old ones. Synchronous: callers are about to exit.
 * @failure any file-system error -> null (a crash report must never cause a second crash)
 */
export function writeCrashReport(input: CrashReportInput, options: WriteOptions): string | null {
  try {
    fs.mkdirSync(options.directory, { recursive: true });
    const now = options.now ?? Date.now();
    const id = freeReportId(options.directory, now);
    const staged = path.join(options.directory, `${id}.partial`);
    fs.mkdirSync(staged, { recursive: true });
    const write = (name: string, text: string): void => fs.writeFileSync(path.join(staged, name), text, 'utf8');
    const text = errorText(input.error);
    write('error.txt', `${text}\n`);
    if (input.documentJson !== undefined) write('document.llull.json', input.documentJson);
    if (input.baseDocumentJson !== undefined) write('base.llull.json', input.baseDocumentJson);
    // Command params carry local paths (import/export file names): redacted like the error.
    if (input.commandLog !== undefined) write('commands.json', `${JSON.stringify(redactStrings(input.commandLog), null, 1)}\n`);
    const meta: CrashMeta = {
      schema: 1,
      id,
      time: new Date(now).toISOString(),
      source: input.source,
      appVersion: input.appVersion ?? serverVersion(),
      versions: Object.fromEntries(
        (['node', 'v8', 'electron', 'chrome'] as const).flatMap((key) => {
          const value = process.versions[key];
          return value === undefined ? [] : [[key, value]];
        }),
      ),
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      ...(input.commandLog?.failing !== undefined ? { failingCommand: input.commandLog.failing.name } : {}),
      loggedCommands: input.commandLog?.commands.length ?? 0,
      hasDocument: input.documentJson !== undefined,
    };
    write('meta.json', `${JSON.stringify(meta, null, 2)}\n`);
    const final = path.join(options.directory, id);
    fs.renameSync(staged, final);
    pruneCrashReports(options.directory, options.keep ?? DEFAULT_KEEP);
    return final;
  } catch (error) {
    console.error(`[llull] could not write a crash report: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readMeta(directory: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readText(path.join(directory, 'meta.json')));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function summaryOf(directory: string, id: string): CrashReportSummary {
  const meta = readMeta(path.join(directory, id));
  const firstLine = readText(path.join(directory, id, 'error.txt')).split(/\r?\n/, 1)[0] ?? '';
  return {
    id,
    time: typeof meta['time'] === 'string' ? meta['time'] : id,
    source: typeof meta['source'] === 'string' ? meta['source'] : 'unknown',
    message: firstLine,
  };
}

/** Every report, newest first. */
export function listCrashReports(directory: string): CrashReportSummary[] {
  return reportIds(directory)
    .reverse()
    .map((id) => summaryOf(directory, id));
}

/** One report by id (`latest` = the newest); null when there is none (ids are validated: no path escapes). */
export function readCrashReport(directory: string, id: string): CrashReport | null {
  const resolved = id === 'latest' ? reportIds(directory).at(-1) : id;
  if (resolved === undefined || !REPORT_ID.test(resolved)) return null;
  const reportDir = path.join(directory, resolved);
  if (!fs.existsSync(reportDir)) return null;
  return {
    ...summaryOf(directory, resolved),
    directory: reportDir,
    errorText: readText(path.join(reportDir, 'error.txt')),
    meta: readMeta(reportDir),
    files: fs.readdirSync(reportDir).sort(),
  };
}

/** A prefilled GitHub "new issue" link for the user to review; opening it is the user's choice, nothing is sent from here. */
export function issueDraftUrl(report: CrashReport): string {
  const errorLines =
    report.errorText.length > MAX_ISSUE_ERROR_CHARS ? `${report.errorText.slice(0, MAX_ISSUE_ERROR_CHARS)}\n…` : report.errorText;
  const meta = report.meta;
  const versions = JSON.stringify(meta['versions'] ?? {});
  const body = [
    `**Crash report** \`${report.id}\` (${report.source})`,
    '',
    `llull ${String(meta['appVersion'] ?? 'unknown')} · ${String(meta['platform'] ?? '')} ${String(meta['arch'] ?? '')} · ${versions}`,
    meta['failingCommand'] !== undefined ? `Failing command: \`${String(meta['failingCommand'])}\`` : '',
    '',
    '```',
    errorLines.trimEnd(),
    '```',
    '',
    'What I was doing:',
    '',
    '<!-- The crash folder also holds document.llull.json and commands.json (they reproduce the crash). They contain your model:',
    '     attach them only if you are happy to share it. -->',
  ].join('\n');
  const title = `Crash: ${report.message}`.slice(0, 120);
  return `${ISSUES_URL}?${new URLSearchParams({ title, body }).toString()}`;
}
