/**
 * SC-D3 local crash reports: the writer (files, redaction, retention), the data-dir rule, `llull crashes`, the issue draft, and the
 * backend hooks (a command that throws in the command bus; a real backend process dying of an uncaught exception / rejection).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import * as registry from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { crashReportsDir, issueDraftUrl, listCrashReports, readCrashReport, redactHome, writeCrashReport } from '../src/crashReports';
import { _resetHistory, applyCommand } from '../src/commandBus';
import { _resetLiveDoc, getLiveDoc } from '../src/liveDocument';
import { runCli, type CliIo } from '../src/cli/main';

let dataDir = '';
let crashes = '';
let previousDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'llull-crash-'));
  crashes = crashReportsDir({ LLULL_DATA_DIR: dataDir });
  previousDataDir = process.env['LLULL_DATA_DIR'];
  process.env['LLULL_DATA_DIR'] = dataDir; // the backend hooks read it
  _resetLiveDoc();
  _resetHistory();
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env['LLULL_DATA_DIR'];
  else process.env['LLULL_DATA_DIR'] = previousDataDir;
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const readJson = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

function replay(commandLog: { replayFrom: string; commands: Array<{ name: string; params: unknown }> }, reportDir: string): CadDocument {
  let doc =
    commandLog.replayFrom === 'empty'
      ? createEmptyDocument()
      : deserializeDocument(readFileSync(path.join(reportDir, commandLog.replayFrom), 'utf8'));
  for (const { name, params } of commandLog.commands) doc = registry.execute(doc, name, params).document;
  return doc;
}

describe('crashReportsDir', () => {
  it('follows LLULL_DATA_DIR, %LOCALAPPDATA%, ~/Library/Application Support, $XDG_DATA_HOME or ~/.local/share', () => {
    expect(crashReportsDir({ LLULL_DATA_DIR: '/t' }, 'win32', '/h')).toBe(path.join('/t', 'llull', 'crashes'));
    expect(crashReportsDir({ LOCALAPPDATA: 'C:\\L' }, 'win32', '/h')).toBe(path.join('C:\\L', 'llull', 'crashes'));
    expect(crashReportsDir({}, 'win32', '/h')).toBe(path.join('/h', 'AppData', 'Local', 'llull', 'crashes'));
    expect(crashReportsDir({}, 'darwin', '/h')).toBe(path.join('/h', 'Library', 'Application Support', 'llull', 'crashes'));
    expect(crashReportsDir({ XDG_DATA_HOME: '/x' }, 'linux', '/h')).toBe(path.join('/x', 'llull', 'crashes'));
    expect(crashReportsDir({ XDG_DATA_HOME: 'relative' }, 'linux', '/h')).toBe(path.join('/h', '.local', 'share', 'llull', 'crashes'));
  });
});

describe('writeCrashReport', () => {
  it('writes document, command log, error and meta; no home path, no environment', () => {
    const error = new Error(`boom in ${path.join(homedir(), 'secret', 'file.ts')}`);
    const documentJson = serializeDocument(createEmptyDocument());
    const dir = writeCrashReport(
      {
        source: 'command-threw',
        error,
        documentJson,
        commandLog: { replayFrom: 'empty', commands: [], failing: { name: 'add_box', params: {} } },
      },
      { directory: crashes, now: T0 },
    );
    expect(dir).toBe(path.join(crashes, '2026-10-19T12-00-00.000Z'));
    expect(readdirSync(dir ?? '').sort()).toEqual(['commands.json', 'document.llull.json', 'error.txt', 'meta.json']);
    const errorText = readFileSync(path.join(dir ?? '', 'error.txt'), 'utf8');
    expect(errorText).toMatch(/^Error: boom in ~/);
    expect(errorText).not.toContain(homedir());
    const metaText = readFileSync(path.join(dir ?? '', 'meta.json'), 'utf8');
    expect(metaText).not.toContain(homedir());
    for (const key of ['PATH', 'USERNAME', 'USER', 'COMPUTERNAME', 'HOSTNAME']) {
      const value = process.env[key];
      if (value !== undefined && value.length > 3) expect(metaText).not.toContain(value);
    }
    expect(readJson(path.join(dir ?? '', 'meta.json'))).toMatchObject({
      schema: 1,
      source: 'command-threw',
      failingCommand: 'add_box',
      hasDocument: true,
    });
  });

  it('keeps the newest 20, names same-millisecond reports apart, ignores foreign folders and never lists a partial one', () => {
    mkdirSync(path.join(crashes, 'keep-me'), { recursive: true });
    mkdirSync(path.join(crashes, '2026-01-01T00-00-00.000Z.partial'), { recursive: true });
    for (let index = 0; index < 23; index++)
      writeCrashReport({ source: 'desktop-main', error: `e${index}` }, { directory: crashes, now: T0 + index * 1000 });
    expect(writeCrashReport({ source: 'desktop-main', error: 'twin' }, { directory: crashes, now: T0 + 22_000 })).toMatch(/Z-2$/);
    const listed = listCrashReports(crashes);
    expect(listed).toHaveLength(20);
    expect(listed[0]?.message).toBe('Non-Error thrown: twin');
    expect(listed.at(-1)?.id).toBe('2026-10-19T12-00-04.000Z');
    expect(existsSync(path.join(crashes, 'keep-me'))).toBe(true);
  });

  it('never throws: an unwritable directory -> null', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const file = path.join(dataDir, 'a-file');
    writeFileSync(file, 'not a directory');
    expect(writeCrashReport({ source: 'desktop-main', error: 'x' }, { directory: path.join(file, 'nested') })).toBe(null);
    expect(readFileSync(file, 'utf8')).toBe('not a directory');
  });

  it('redacts both separator spellings of the home directory', () => {
    expect(redactHome('at C:\\Users\\me\\x and C:/Users/me/y', 'C:\\Users\\me')).toBe('at ~\\x and ~/y');
  });
});

describe('readCrashReport / issueDraftUrl', () => {
  it('reads by id or latest, refuses ids that are not report names', () => {
    writeCrashReport({ source: 'server-uncaught-exception', error: new Error('first') }, { directory: crashes, now: T0 });
    writeCrashReport({ source: 'server-uncaught-exception', error: new Error('second') }, { directory: crashes, now: T0 + 1 });
    expect(readCrashReport(crashes, 'latest')?.message).toBe('Error: second');
    expect(readCrashReport(crashes, '2026-10-19T12-00-00.000Z')?.message).toBe('Error: first');
    expect(readCrashReport(crashes, '../../etc')).toBe(null);
    expect(readCrashReport(crashes, '2026-10-19T12-59-59.000Z')).toBe(null);
    expect(readCrashReport(path.join(dataDir, 'none'), 'latest')).toBe(null);
  });

  it('drafts a prefilled GitHub issue with the error, never the document', () => {
    const documentJson = serializeDocument(
      registry.execute(createEmptyDocument(), 'add_box', { size: [1, 2, 3], name: 'TopSecretPart' }).document,
    );
    writeCrashReport({ source: 'command-threw', error: new Error('kaboom'), documentJson }, { directory: crashes, now: T0 });
    const report = readCrashReport(crashes, 'latest');
    if (report === null) throw new Error('no report');
    const url = new URL(issueDraftUrl(report));
    expect(url.origin + url.pathname).toBe('https://github.com/GauthierRobert/Llull/issues/new');
    expect(url.searchParams.get('title')).toBe('Crash: Error: kaboom');
    expect(url.searchParams.get('body')).toContain('kaboom');
    expect(url.toString()).not.toContain('TopSecretPart');
  });
});

describe('llull crashes', () => {
  function capture(): { io: CliIo; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      readStdin: () => Promise.resolve(''),
      env: { LLULL_DATA_DIR: dataDir },
      prepareKernel: () => Promise.resolve(),
    };
    return { io, out, err };
  }

  it('dir, list (empty and not), show latest / id / missing, bad usage', async () => {
    let run = capture();
    expect(await runCli(['crashes', 'dir'], run.io)).toBe(0);
    expect(run.out).toEqual([crashes]);
    run = capture();
    expect(await runCli(['crashes', 'list'], run.io)).toBe(0);
    expect(run.out[0]).toMatch(/^No crash reports/);
    writeCrashReport({ source: 'server-uncaught-exception', error: new Error('listed') }, { directory: crashes, now: T0 });
    run = capture();
    expect(await runCli(['crashes'], run.io)).toBe(0);
    expect(run.out[0]).toMatch(/^2026-10-19T12-00-00\.000Z\s+server-uncaught-exception\s+Error: listed$/);
    run = capture();
    expect(await runCli(['crashes', 'list', '--json'], run.io)).toBe(0);
    expect((JSON.parse(run.out[0] ?? '') as { reports: unknown[] }).reports).toHaveLength(1);
    run = capture();
    expect(await runCli(['crashes', 'show', 'latest'], run.io)).toBe(0);
    expect(run.out[0]).toContain('Error: listed');
    expect(run.out[0]).toContain('https://github.com/GauthierRobert/Llull/issues/new?');
    run = capture();
    expect(await runCli(['crashes', 'show', '2026-10-19T12-00-00.000Z', '--json'], run.io)).toBe(0);
    expect(JSON.parse(run.out[0] ?? '')).toMatchObject({
      source: 'server-uncaught-exception',
      issueUrl: expect.stringContaining('github.com'),
    });
    run = capture();
    expect(await runCli(['crashes', 'show', 'nope'], run.io)).toBe(1);
    expect(await runCli(['crashes', 'show'], run.io)).toBe(2);
    expect(await runCli(['crashes', 'burn'], run.io)).toBe(2);
    expect(run.err.join('\n')).toMatch(/usage: llull crashes/);
  });

  it('is in the help text', async () => {
    const run = capture();
    await runCli(['help'], run.io);
    expect(run.out[0]).toMatch(/crashes list\|show ID\|dir/);
  });
});

describe('a command that throws in the backend', () => {
  it('writes a report whose command log rebuilds the document it ran on, plus the failing command', () => {
    expect(applyCommand('add_box', { size: [10, 20, 30] }).changed).toBe(true);
    expect(applyCommand('add_sphere', { radius: 3, position: [20, 0, 0] }).changed).toBe(true);
    const before = getLiveDoc();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(registry, 'execute').mockImplementation(() => {
      throw new Error('command blew up');
    });
    expect(applyCommand('add_box', { size: [1, 1, 1] }).isError).toBe(true);
    vi.restoreAllMocks();
    const report = readCrashReport(crashes, 'latest');
    if (report === null) throw new Error('no crash report');
    expect(report.source).toBe('command-threw');
    expect(report.errorText).toMatch(/^Error: command blew up/);
    const commandLog = readJson(path.join(report.directory, 'commands.json')) as Parameters<typeof replay>[0] & { failing: unknown };
    expect(commandLog.failing).toEqual({ name: 'add_box', params: { size: [1, 1, 1] } });
    expect(commandLog.commands.map((command) => command.name)).toEqual(['add_box', 'add_sphere']);
    expect(serializeDocument(replay(commandLog, report.directory))).toBe(serializeDocument(before));
    expect(readFileSync(path.join(report.directory, 'document.llull.json'), 'utf8')).toBe(serializeDocument(before));
  });

  it("a command's own failure summary is not a crash", () => {
    expect(applyCommand('add_box', { size: [-1, 1, 1] }).changed).toBe(false);
    expect(listCrashReports(crashes)).toEqual([]);
  });
});

describe('a backend process dying of an uncaught error', () => {
  const serverDir = path.resolve(__dirname, '..');
  const childScript = (): string => {
    const outfile = path.join(dataDir, 'crashChild.cjs');
    buildSync({
      entryPoints: [path.join(__dirname, 'fixtures', 'crashChild.ts')],
      absWorkingDir: serverDir,
      tsconfig: path.join(serverDir, 'tsconfig.json'),
      bundle: true,
      packages: 'external',
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      outfile,
      logLevel: 'error',
    });
    return outfile;
  };

  it.each([
    ['exception', 'server-uncaught-exception', 'crash child exploded'],
    ['rejection', 'server-unhandled-rejection', 'crash child rejected'],
  ])(
    '%s: exits 1 and leaves a report with the document and its command log',
    (mode, source, message) => {
      const result = spawnSync(process.execPath, [childScript(), mode], {
        env: {
          ...process.env,
          LLULL_DATA_DIR: dataDir,
          NODE_PATH: [path.join(serverDir, 'node_modules'), path.join(serverDir, '..', 'node_modules')].join(path.delimiter),
        },
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('crash report written to');
      const report = readCrashReport(crashes, 'latest');
      if (report === null) throw new Error(`no crash report: ${result.stderr}`);
      expect(report.source).toBe(source);
      expect(report.errorText).toContain(message);
      const saved = deserializeDocument(readFileSync(path.join(report.directory, 'document.llull.json'), 'utf8'));
      expect(Object.values(saved.entities).map((entity) => entity.kind)).toEqual(['box', 'cylinder']);
      const commandLog = readJson(path.join(report.directory, 'commands.json')) as Parameters<typeof replay>[0];
      expect(serializeDocument(replay(commandLog, report.directory))).toBe(serializeDocument(saved));
    },
    90_000,
  );
});
