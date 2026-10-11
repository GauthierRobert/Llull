/**
 * @layer server
 * The `llull` CLI: the command registry from a shell, for agents with a terminal (Claude Code) and
 * scripts/CI. A third caller of `execute` beside the UI and MCP (L1) — argument parsing and
 * printing only; every document change is a registry command, locally or through the server.
 *
 * `runCli` takes its I/O as a port so tests drive it without a process; `bin.ts` wires the real one.
 */

import fs from 'fs';
import { getCommand } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { CONVENTIONS_GUIDE } from '@mcp/index';
import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';
import {
  booleanFlag,
  missingValueFlag,
  paramsSource,
  parseArgv,
  stringFlag,
  type ParsedArgv,
} from './argv';
import {
  createLocalBackend,
  createRemoteBackend,
  writeDocumentFile,
  type CliBackend,
  type CliRunResult,
} from './backend';
import {
  describeCommand,
  isToolsetName,
  listCatalog,
  searchCatalog,
  suggestNames,
  toolsetCounts,
  type CatalogEntry,
} from './catalog';
import { planText, resultJson, resultText, type PrintableResult } from './output';
import { createStepObserver, type StepObserver } from './progress';
import { saveDataFiles, withoutPayloads } from './saveFiles';
import { USAGE } from './usage';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly readStdin: () => Promise<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Install the geometry kernel before a local command runs (no-op in tests that skip it). */
  readonly prepareKernel: () => Promise<void>;
  /** Injected for tests of `--server`; the global `fetch` otherwise. */
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Millisecond clock for step timing and `--timeout`; `Date.now` otherwise. */
  readonly now?: () => number;
  /** stderr is a terminal: stream per-step progress without `--progress`. */
  readonly stderrIsTty?: boolean;
}

/** Exit codes: 0 success, 1 the command failed or changed nothing (`withOutcome`), 2 bad usage / unreadable input. */
export const EXIT_OK = 0;
export const EXIT_COMMAND_ERROR = 1;
export const EXIT_USAGE = 2;

const DEFAULT_DOC = 'model.llull.json';
const DEFAULT_SEARCH_LIMIT = 10;

class UsageError extends Error {}

function docPathOf(args: ParsedArgv, io: CliIo): string {
  return stringFlag(args, 'doc') ?? io.env['LLULL_DOC'] ?? DEFAULT_DOC;
}

function serverOf(args: ParsedArgv, io: CliIo): string | undefined {
  return stringFlag(args, 'server') ?? io.env['LLULL_SERVER'];
}

/** `--timeout <seconds>`: a positive number, or undefined when absent. */
function timeoutOf(args: ParsedArgv): number | undefined {
  const raw = stringFlag(args, 'timeout');
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new UsageError(`--timeout needs a positive number of seconds (got "${raw}").`);
  return seconds;
}

/** Progress/timing/deadline observer of a local run; a `--server` run is the server's to execute. */
function observerOf(args: ParsedArgv, io: CliIo): StepObserver | undefined {
  if (serverOf(args, io) !== undefined) {
    if (booleanFlag(args, 'progress'))
      io.stderr('llull: --progress has no effect with --server (the server runs the plan).');
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

/** A run stopped by its `--timeout` deadline is a failure with a clear message, never a partial result. */
function withTimeout(observer: StepObserver | undefined, result: CliRunResult): CliRunResult {
  const stop = observer?.timeout();
  if (stop === undefined) return result;
  return {
    summary: `llull: timed out after ${stop.seconds}s (--timeout) before step ${stop.ordinal}/${stop.total} (${stop.command}); stopped, nothing was saved.`,
    affected: [],
    isError: true,
    changed: false,
  };
}

async function backendOf(
  args: ParsedArgv,
  io: CliIo,
  observer?: StepObserver,
): Promise<CliBackend> {
  const server = serverOf(args, io);
  if (server !== undefined) {
    if (booleanFlag(args, 'dry-run'))
      throw new UsageError('--dry-run works on a local --doc only; the server applies every call.');
    const token = stringFlag(args, 'token') ?? io.env['LLULL_TOKEN'];
    const timeoutSeconds = timeoutOf(args);
    return createRemoteBackend(server, {
      token,
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      ...(io.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {}),
    });
  }
  await io.prepareKernel();
  return createLocalBackend(docPathOf(args, io), {
    dryRun: booleanFlag(args, 'dry-run'),
    ...(observer !== undefined ? { observer } : {}),
  });
}

async function readSource(source: string, io: CliIo): Promise<string> {
  if (source === '-') return io.readStdin();
  try {
    return fs.readFileSync(source, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read ${source}: ${errorMessage(error)}`);
  }
}

function parseJson(text: string, origin: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(`${origin} is not valid JSON: ${errorMessage(error)}`);
  }
}

/** Top-level params declared as plain strings: their `key=value` values are never JSON-parsed. */
function stringParamKeys(name: string): ReadonlySet<string> {
  const properties = getCommand(name)?.paramsSchema.properties ?? {};
  return new Set(
    Object.entries(properties)
      .filter(([, spec]) => spec.type === 'string')
      .map(([key]) => key),
  );
}

async function paramsOf(name: string, tokens: readonly string[], io: CliIo): Promise<unknown> {
  let source: ReturnType<typeof paramsSource>;
  try {
    source = paramsSource(tokens, stringParamKeys(name));
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
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

function unknownCommand(name: string): never {
  const hints = suggestNames(name);
  throw new UsageError(
    `unknown command "${name}".${hints.length > 0 ? ` Did you mean: ${hints.join(', ')}?` : ''} Find one with: llull search <words>`,
  );
}

/** Print a result, honouring `--save` (write the payload, keep only metadata) and `--json`. */
function finish(
  result: PrintableResult,
  args: ParsedArgv,
  io: CliIo,
  text: (r: PrintableResult) => string = resultText,
): number {
  let printable = result;
  const save = stringFlag(args, 'save');
  if (save !== undefined && !result.isError) {
    try {
      const saved = saveDataFiles(result.data, save);
      printable = { ...result, data: withoutPayloads(result.data), saved };
    } catch (error) {
      // The command itself ran (and a local change is already saved): still report it.
      io.stderr(booleanFlag(args, 'json') ? resultJson(result) : text(result));
      io.stderr(`llull: --save: ${errorMessage(error)}`);
      return EXIT_COMMAND_ERROR;
    }
  }
  if (!booleanFlag(args, 'quiet') || printable.isError)
    io.stdout(booleanFlag(args, 'json') ? resultJson(printable) : text(printable));
  return printable.isError ? EXIT_COMMAND_ERROR : EXIT_OK;
}

function printEntries(entries: readonly CatalogEntry[], args: ParsedArgv, io: CliIo): number {
  if (booleanFlag(args, 'json')) {
    io.stdout(JSON.stringify(entries));
    return EXIT_OK;
  }
  io.stdout(
    entries
      .map((e) => `${e.name} [${e.toolset}${e.readOnly ? ', read-only' : ''}] ${e.description}`)
      .join('\n'),
  );
  return EXIT_OK;
}

/**
 * A result whose exit status a script can trust: besides a rejection, a failed plan (`data.ok`
 * false) and a mutating command that changed nothing (a graceful no-op such as "add_box failed: …")
 * are errors — except setters (`idempotent`) and history meta-commands, which may change nothing.
 */
function withOutcome(name: string, result: CliRunResult): CliRunResult {
  if (result.isError) return result;
  const failedReport = isRecord(result.data) && result.data['ok'] === false;
  const annotations = getCommand(name)?.annotations;
  // Setters (`idempotent`) and history meta-commands may legitimately change nothing.
  const mayNoop =
    annotations?.readOnly === true ||
    annotations?.idempotent === true ||
    annotations?.metaHistory === true;
  const noop = !mayNoop && !result.changed && result.data === undefined;
  return failedReport || noop ? { ...result, isError: true } : result;
}

async function runExec(args: ParsedArgv, io: CliIo): Promise<number> {
  const [, name, ...rest] = args.positionals;
  if (name === undefined)
    throw new UsageError('exec needs a command name: llull exec <command> [params]');
  if (getCommand(name) === undefined) unknownCommand(name);
  const params = await paramsOf(name, rest, io);
  const observer = observerOf(args, io);
  const backend = await backendOf(args, io, observer);
  return finish(
    withTimeout(observer, withOutcome(name, await backend.run(name, params))),
    args,
    io,
  );
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
  return finish(
    withTimeout(observer, withOutcome('build_project', await backend.run('build_project', params))),
    args,
    io,
    planText,
  );
}

function runNew(args: ParsedArgv, io: CliIo): number {
  if (serverOf(args, io) !== undefined)
    throw new UsageError('new creates a local document file; it does not apply to --server.');
  const docPath = docPathOf(args, io);
  if (fs.existsSync(docPath) && !booleanFlag(args, 'force'))
    throw new UsageError(`${docPath} exists; pass --force to replace it with an empty document.`);
  writeDocumentFile(docPath, createEmptyDocument());
  io.stdout(`Created empty document ${docPath}.`);
  return EXIT_OK;
}

function runList(args: ParsedArgv, io: CliIo): number {
  const toolset = stringFlag(args, 'toolset') ?? args.positionals[1];
  if (toolset !== undefined && !isToolsetName(toolset))
    throw new UsageError(`unknown toolset "${toolset}"; see: llull toolsets`);
  return printEntries(listCatalog(toolset), args, io);
}

function runSearch(args: ParsedArgv, io: CliIo): number {
  const query = args.positionals.slice(1).join(' ').trim();
  if (query === '') throw new UsageError('search needs words: llull search fillet edge');
  const limit = Number(stringFlag(args, 'limit') ?? DEFAULT_SEARCH_LIMIT);
  const entries = searchCatalog(
    query,
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_SEARCH_LIMIT,
  );
  if (entries.length === 0 && !booleanFlag(args, 'json')) {
    io.stdout(`No command matches "${query}". Browse with: llull list <toolset>`);
    return EXIT_OK;
  }
  return printEntries(entries, args, io);
}

function runDescribe(args: ParsedArgv, io: CliIo): number {
  const names = args.positionals.slice(1);
  if (names.length === 0)
    throw new UsageError('describe needs a command name: llull describe add_box');
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
  io.stdout(
    booleanFlag(args, 'json')
      ? JSON.stringify(counts)
      : counts.map((c) => `${c.toolset}: ${c.commands} command(s)`).join('\n'),
  );
  return EXIT_OK;
}

async function runHistory(
  direction: 'undo' | 'redo',
  args: ParsedArgv,
  io: CliIo,
): Promise<number> {
  const backend = await backendOf(args, io);
  return finish(await (direction === 'undo' ? backend.undo() : backend.redo()), args, io);
}

/** Run one CLI invocation; resolves to the process exit code. */
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
      case 'new':
        return runNew(args, io);
      case 'undo':
      case 'redo':
        return await runHistory(subcommand, args, io);
      default:
        // `llull add_box width=10` is `llull exec add_box width=10`.
        if (getCommand(subcommand) !== undefined)
          return await runExec(parseArgv(['exec', ...argv]), io);
        throw new UsageError(`unknown subcommand "${subcommand}"; see: llull help`);
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`llull: ${error.message}`);
    return EXIT_USAGE;
  }
}
