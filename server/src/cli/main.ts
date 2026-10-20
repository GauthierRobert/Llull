/** The `llull` CLI: third caller of `execute` (L1), parsing + printing only. I/O is a port (`bin.ts` wires the real one). */
import fs from 'fs';
import { getCommand } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { CONVENTIONS_GUIDE, isToolsetName } from '@protocol/index';
import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';
import { booleanFlag, missingValueFlag, paramsSource, APP_SERVER, cliTarget, parseArgv, stringFlag, type ParsedArgv } from './argv';
import { createLocalBackend, createRemoteBackend, saveDocumentWithBackup, type CliBackend } from './backend';
import { describeCommand, listCatalog, searchCatalog, suggestNames, toolsetCounts, type CatalogEntry } from './catalog';
import { planAliases } from './aliases';
import { planText, resultJson, resultText, type PrintableResult } from './output';
import { createStepObserver, type StepObserver } from './progress';
import { resolveFileRefs } from './fileParams';
import { saveDataFiles, withoutPayloads, withSaveDefaults } from './saveFiles';
import { llullHome, readDesktopDiscovery } from './desktopDiscovery';
import { exchangeTool, takesFileParam, withFileContent } from './exchange';
import type { CommandOutcome } from '@protocol/restProtocol';
import { isHealthy } from '../restClient';
import { withFailureStatus } from '@protocol/commandOutcome';
import { exchangeOptionsWithDwg } from '../dwgConvert';
import type { ExchangeOptions } from '../pythonExchange';
import { USAGE } from './usage';
import { getGeometryKernel } from '@core/geometry/kernel';
import { planKernelWarnings } from './planKernelWarning';
import { benchmarkCli } from './benchmarks';
import { PlmUsage, confirmedParams, runPlmCli } from './plm';
import { runVault } from './vault';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly readStdin: () => Promise<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly prepareKernel: () => Promise<void>; // installs the kernel before a local command
  readonly exchangeOptions?: () => ExchangeOptions; // default: from `env`
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number; // ms clock for step timing and `--timeout`
  readonly readPassphrase?: (prompt: string) => Promise<string | null>; // signing passphrase: an interactive no-echo prompt only (never env, flag or stdin)
  readonly stderrIsTty?: boolean; // stream per-step progress without `--progress`
}

/** 1 = the command failed or changed nothing (`withFailureStatus`); 2 = bad usage / unreadable input. */
export const EXIT_OK = 0;
export const EXIT_COMMAND_ERROR = 1;
export const EXIT_USAGE = 2;

const DEFAULT_SEARCH_LIMIT = 10;

class UsageError extends Error {}

/** `body()`, any failure rethrown as a `UsageError` (prefixed by `prefix`). */
function asUsage<T>(body: () => T, prefix = ''): T {
  try {
    return body();
  } catch (error) {
    throw error instanceof UsageError ? error : new UsageError(`${prefix}${errorMessage(error)}`);
  }
}

const docPathOf = (args: ParsedArgv, io: CliIo): string => cliTarget(args, io.env).doc;
const serverOf = (args: ParsedArgv, io: CliIo): string | undefined => cliTarget(args, io.env).server;

function timeoutOf(args: ParsedArgv): number | undefined {
  const raw = stringFlag(args, 'timeout');
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError(`--timeout needs a positive number of seconds (got "${raw}").`);
  return seconds;
}

function observerOf(args: ParsedArgv, io: CliIo): StepObserver | undefined {
  if (serverOf(args, io) !== undefined) {
    if (booleanFlag(args, 'progress')) io.stderr('llull: --progress has no effect with --server (the server runs the plan).');
    return undefined;
  }
  const timeoutSeconds = timeoutOf(args);
  return createStepObserver({
    now: io.now ?? Date.now,
    print: io.stderr,
    progress: booleanFlag(args, 'progress') || io.stderrIsTty === true,
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
  });
}

/** A run stopped by `--timeout` is a failure, never a partial result. */
function withTimeout(observer: StepObserver | undefined, result: CommandOutcome): CommandOutcome {
  const stop = observer?.timeout();
  return stop === undefined
    ? result
    : {
        summary: `llull: timed out after ${stop.seconds}s (--timeout) before step ${stop.ordinal}/${stop.total} (${stop.command}); stopped, nothing was saved.`,
        affected: [],
        isError: true,
        changed: false,
      };
}

function remoteTargetOf(server: string, args: ParsedArgv, io: CliIo): { url: string; token?: string } {
  const flagToken = stringFlag(args, 'token');
  if (server !== APP_SERVER) {
    const token = flagToken ?? io.env['LLULL_TOKEN'];
    return { url: server, ...(token !== undefined ? { token } : {}) };
  }
  const app = readDesktopDiscovery(llullHome(io.env));
  if (app === null)
    throw new UsageError('the llull desktop app is not running (llull status). Start it, or drop --app to work on a local --doc file.');
  // $LLULL_TOKEN belongs to --server (often a cloud token); the app has its own per-launch token.
  return { url: app.url, token: flagToken ?? app.token };
}

async function backendOf(args: ParsedArgv, io: CliIo, observer?: StepObserver): Promise<CliBackend> {
  const server = serverOf(args, io);
  if (server !== undefined) {
    if (booleanFlag(args, 'dry-run')) throw new UsageError('--dry-run works on a local --doc only; the server applies every call.');
    const target = remoteTargetOf(server, args, io);
    const timeoutSeconds = timeoutOf(args);
    return createRemoteBackend(target.url, {
      token: target.token,
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      ...(io.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {}),
    });
  }
  await io.prepareKernel();
  return createLocalBackend(docPathOf(args, io), {
    dryRun: booleanFlag(args, 'dry-run'),
    ...(observer !== undefined ? { observer } : {}),
    exchangeOptions: io.exchangeOptions ?? (() => exchangeOptionsWithDwg({ ...io.env })),
  });
}

const readSource = async (source: string, io: CliIo): Promise<string> =>
  source === '-' ? io.readStdin() : asUsage(() => fs.readFileSync(source, 'utf8'), `cannot read ${source}: `);

const parseJson = (text: string, origin: string): unknown => asUsage(() => JSON.parse(text) as unknown, `${origin} is not valid JSON: `);

/** Top-level params declared as plain strings: their `key=value` values are never JSON-parsed. */
function stringParamKeys(name: string): ReadonlySet<string> {
  const properties = getCommand(name)?.paramsSchema.properties ?? exchangeTool(name)?.inputSchema.properties ?? {};
  return new Set(
    Object.entries(properties)
      .filter(([, spec]) => spec.type === 'string')
      .map(([key]) => key),
  );
}

/** Params of `name`, with `@img:<path>` values loaded as image data URLs and `@text:<path>` values as file text. */
async function paramsOf(name: string, tokens: readonly string[], io: CliIo): Promise<unknown> {
  const params = await rawParamsOf(name, tokens, io);
  return asUsage(() => resolveFileRefs(params, (source) => asUsage(() => fs.readFileSync(source), `cannot read ${source}: `)));
}

async function rawParamsOf(name: string, tokens: readonly string[], io: CliIo): Promise<unknown> {
  const source = asUsage(() => paramsSource(tokens, stringParamKeys(name)));
  switch (source.kind) {
    case 'pairs':
      return source.params;
    case 'json':
      return parseJson(source.text, 'params');
    case 'stdin':
      return parseJson(await io.readStdin(), 'stdin');
    case 'file':
      return parseJson(await readSource(source.path, io), source.path);
  }
}

function unknownSubcommandMessage(name: string): string {
  const hints = suggestNames(name);
  return `unknown subcommand "${name}".${hints.length > 0 ? ` Did you mean: ${hints.join(', ')}?` : ''} See: llull help`;
}

function unknownCommand(name: string): never {
  const hints = suggestNames(name);
  throw new UsageError(
    `unknown command "${name}".${hints.length > 0 ? ` Did you mean: ${hints.join(', ')}?` : ''} Find one with: llull search <words>`,
  );
}

/** Print a result, honouring `--save` (write the payload, keep only metadata) and `--json`. */
function finish(result: PrintableResult, args: ParsedArgv, io: CliIo, text: (r: PrintableResult) => string = resultText): number {
  let printable = result;
  const save = stringFlag(args, 'save');
  if (save !== undefined && !result.isError) {
    try {
      const saved = saveDataFiles(result.data, save);
      printable = { ...result, data: withoutPayloads(result.data), saved };
    } catch (error) {
      // The command ran (a local change is already saved): still report it.
      io.stderr(booleanFlag(args, 'json') ? resultJson(result) : text(result));
      io.stderr(`llull: --save: ${errorMessage(error)}`);
      return EXIT_COMMAND_ERROR;
    }
  }
  if (!booleanFlag(args, 'quiet') || printable.isError) io.stdout(booleanFlag(args, 'json') ? resultJson(printable) : text(printable));
  return printable.isError ? EXIT_COMMAND_ERROR : EXIT_OK;
}

function printEntries(entries: readonly CatalogEntry[], args: ParsedArgv, io: CliIo): number {
  io.stdout(
    booleanFlag(args, 'json')
      ? JSON.stringify(entries)
      : entries.map((e) => `${e.name} [${e.toolset}${e.readOnly ? ', read-only' : ''}] ${e.description}`).join('\n'),
  );
  return EXIT_OK;
}

async function runExec(args: ParsedArgv, io: CliIo): Promise<number> {
  const [, name, ...rest] = args.positionals;
  if (name === undefined) throw new UsageError('exec needs a command name: llull exec <command> [params]');
  const isExchange = exchangeTool(name) !== undefined;
  if (getCommand(name) === undefined && !isExchange) unknownCommand(name);
  const raw = await paramsOf(name, rest, io);
  const params = asUsage(() => withSaveDefaults(name, takesFileParam(name) ? withFileContent(name, raw) : raw, stringFlag(args, 'save')));
  const observer = observerOf(args, io);
  const backend = await backendOf(args, io, observer);
  const confirmKey = stringFlag(args, 'confirm-key');
  let sent: unknown = params;
  if (confirmKey !== undefined && !isExchange) {
    try {
      sent = await confirmedParams(backend, name, params, confirmKey, io);
    } catch (error) {
      if (error instanceof PlmUsage) throw new UsageError(error.message);
      throw error;
    }
  }
  const result = isExchange ? await backend.exchange(name, params) : await backend.run(name, sent);
  return finish(withTimeout(observer, withFailureStatus(name, result)), args, io);
}

const CAMERA_COMMANDS = new Set(['fit_view', 'set_camera']);

/** Command names of a plan, loop bodies included. */
function planCommands(actions: readonly unknown[], into = new Set<string>()): Set<string> {
  for (const action of actions) {
    if (!isRecord(action)) continue;
    if (typeof action['command'] === 'string') into.add(action['command']);
    if (Array.isArray(action['actions'])) planCommands(action['actions'], into);
  }
  return into;
}

/**
 * The camera is document state that a plan does not move: after a plan that built something and never set the camera itself, frame the
 * model (fit_view, current angle) so the app and later renders do not open on a speck or inside the part. Skipped by --no-fit,
 * --validate, --dry-run and a failed plan.
 */
async function frameAfterPlan(
  args: ParsedArgv,
  actions: readonly unknown[],
  result: CommandOutcome,
  backend: CliBackend,
): Promise<boolean> {
  if (result.isError || booleanFlag(args, 'no-fit') || booleanFlag(args, 'validate') || booleanFlag(args, 'dry-run')) return false;
  if (!result.changed || [...planCommands(actions)].some((name) => CAMERA_COMMANDS.has(name))) return false;
  const fitted = await backend.run('fit_view', { direction: 'current' });
  return !fitted.isError;
}

async function runPlan(args: ParsedArgv, io: CliIo): Promise<number> {
  const source = args.positionals[1];
  if (source === undefined) throw new UsageError('run needs a plan: llull run <plan.json | ->');
  const plan = parseJson(await readSource(source, io), source);
  const base = Array.isArray(plan) ? { actions: plan } : plan;
  if (!isRecord(base) || !Array.isArray(base['actions']))
    throw new UsageError(`${source}: a plan is an actions array or an object with "actions".`);
  const params = {
    ...base,
    ...(booleanFlag(args, 'validate') ? { validate: true } : {}),
    ...(booleanFlag(args, 'continue') ? { onError: 'continue' } : {}),
  };
  const observer = observerOf(args, io);
  const backend = await backendOf(args, io, observer);
  const result = withTimeout(observer, withFailureStatus('build_project', await backend.run('build_project', params)));
  const framed = await frameAfterPlan(args, base['actions'], result, backend);
  const found = planAliases(result.data);
  const warnings = booleanFlag(args, 'validate') && serverOf(args, io) === undefined ? planKernelWarnings(params, getGeometryKernel()) : [];
  const printable: PrintableResult = {
    ...result,
    ...(found !== null ? { planAliases: found } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(framed ? { summary: `${result.summary} Camera framed on the model (fit_view; --no-fit to keep it).` } : {}),
  };
  return finish(printable, args, io, planText);
}

function runNew(args: ParsedArgv, io: CliIo): number {
  if (serverOf(args, io) !== undefined) throw new UsageError('new creates a local document file; it does not apply to --server.');
  const docPath = docPathOf(args, io);
  if (fs.existsSync(docPath) && !booleanFlag(args, 'force'))
    throw new UsageError(`${docPath} exists; pass --force to replace it with an empty document.`);
  saveDocumentWithBackup(docPath, createEmptyDocument());
  io.stdout(`Created empty document ${docPath}.`);
  return EXIT_OK;
}

function runList(args: ParsedArgv, io: CliIo): number {
  const toolset = stringFlag(args, 'toolset') ?? args.positionals[1];
  if (toolset !== undefined && !isToolsetName(toolset)) throw new UsageError(`unknown toolset "${toolset}"; see: llull toolsets`);
  return printEntries(listCatalog(toolset), args, io);
}

function runSearch(args: ParsedArgv, io: CliIo): number {
  const query = args.positionals.slice(1).join(' ').trim();
  if (query === '') throw new UsageError('search needs words: llull search fillet edge');
  const limit = Number(stringFlag(args, 'limit') ?? DEFAULT_SEARCH_LIMIT);
  const entries = searchCatalog(query, Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_SEARCH_LIMIT);
  if (entries.length === 0 && !booleanFlag(args, 'json')) {
    io.stdout(`No command matches "${query}". Browse with: llull list <toolset>`);
    return EXIT_OK;
  }
  return printEntries(entries, args, io);
}

function runDescribe(args: ParsedArgv, io: CliIo): number {
  const names = args.positionals.slice(1);
  if (names.length === 0) throw new UsageError('describe needs a command name: llull describe add_box');
  const described = names.map((name) => describeCommand(name) ?? unknownCommand(name));
  io.stdout(
    booleanFlag(args, 'json')
      ? JSON.stringify(described.length === 1 ? described[0]?.json : described.map((d) => d.json))
      : described.map((d) => d.text).join('\n\n'),
  );
  return EXIT_OK;
}

function runToolsets(args: ParsedArgv, io: CliIo): number {
  const counts = toolsetCounts();
  io.stdout(booleanFlag(args, 'json') ? JSON.stringify(counts) : counts.map((c) => `${c.toolset}: ${c.commands} command(s)`).join('\n'));
  return EXIT_OK;
}

async function runStatus(args: ParsedArgv, io: CliIo): Promise<number> {
  const found = readDesktopDiscovery(llullHome(io.env));
  const app = found !== null && (await isHealthy(found.url, io.fetchImpl)) ? found : null; // its pid may be reused after a crash
  const docPath = docPathOf(args, io);
  if (booleanFlag(args, 'json')) {
    io.stdout(
      JSON.stringify({
        app: app === null ? null : { url: app.url, pid: app.pid, documentPath: app.documentPath, version: app.version },
        doc: docPath,
        docExists: fs.existsSync(docPath),
      }),
    );
    return EXIT_OK;
  }
  io.stdout(
    [
      app === null
        ? 'Desktop app: not running.'
        : `Desktop app: running at ${app.url} (pid ${app.pid}, v${app.version}), document ${app.documentPath ?? '(unsaved)'} — use --app to act on it.`,
      `Local document: ${docPath}${fs.existsSync(docPath) ? '' : ' (not created yet)'}.`,
    ].join('\n'),
  );
  return EXIT_OK;
}

async function runHistory(direction: 'undo' | 'redo', args: ParsedArgv, io: CliIo): Promise<number> {
  const backend = await backendOf(args, io);
  return finish(await (direction === 'undo' ? backend.undo() : backend.redo()), args, io);
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const args = parseArgv(argv);
  const subcommand = args.positionals[0];
  try {
    const valueless = missingValueFlag(args);
    if (valueless !== undefined) throw new UsageError(`--${valueless} needs a value.`);
    if (subcommand === undefined || subcommand === 'help' || booleanFlag(args, 'help')) {
      io.stdout(USAGE);
      return EXIT_OK;
    }
    switch (subcommand) {
      case 'exec':
        return await runExec(args, io);
      case 'run':
        return await runPlan(args, io);
      case 'list':
        return runList(args, io);
      case 'search':
        return runSearch(args, io);
      case 'describe':
        return runDescribe(args, io);
      case 'toolsets':
        return runToolsets(args, io);
      case 'guide':
        io.stdout(CONVENTIONS_GUIDE);
        return EXIT_OK;
      case 'status':
        return await runStatus(args, io);
      case 'new':
        return runNew(args, io);
      case 'undo':
      case 'redo':
        return await runHistory(subcommand, args, io);
      case 'vault':
        return runVault(args, io);
      case 'keys':
      case 'release':
      case 'lotar':
      case 'audit':
        return await runPlmCli(args, io, () => backendOf(args, io));
      case 'run_benchmarks': {
        const save = stringFlag(args, 'save');
        return benchmarkCli(
          args.positionals.slice(1),
          { json: booleanFlag(args, 'json'), ...(save !== undefined ? { save } : {}) },
          { stdout: io.stdout, cwd: process.cwd() },
        );
      }
      default:
        // `llull add_box width=10` is `llull exec add_box width=10`.
        if (getCommand(subcommand) !== undefined || exchangeTool(subcommand) !== undefined)
          return await runExec(parseArgv(['exec', ...argv]), io);
        throw new UsageError(unknownSubcommandMessage(subcommand));
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`llull: ${error.message}`);
    return EXIT_USAGE;
  }
}
