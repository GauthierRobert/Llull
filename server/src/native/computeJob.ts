/**
 * `llull-compute` job runner (RS1 §2): one tracked child per job in a temporary job folder, hard timeout (whole process tree killed), NDJSON
 * events parsed from stdout (progress / warning / done / error), last 64 KB of stderr kept, outputs re-hashed before they are read. The async
 * runner serves tools and commands that may await; `runComputeSync` serves the synchronous host ports (ctx.raster, ctx.pointCloud).
 * Missing binary -> NATIVE_TOOL_MISSING with the install hint (llull stays usable: the TypeScript paths remain).
 * Environment: LLULL_COMPUTE (binary override), LLULL_NATIVE_DIR (bundle), LLULL_NATIVE_KEEP=1 (keep job folders), RAYON_NUM_THREADS.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { endianness, tmpdir } from 'node:os';
import path from 'node:path';
import { isRecord } from '@lib/isRecord';
import { runProcess, runProcessSync, type ProcessOutcome } from '../processRunner';
import { sha256Hex } from '../sha256';
import { nativeBinaryPath, nativeInstallHint } from './nativeBinary';

const LOG_TAIL_BYTES = 64 * 1024;
/** Named guard: longest stdout line accepted from the binary (an event is a few hundred bytes). */
const MAX_LINE_BYTES = 1024 * 1024;
const VERSION_TIMEOUT_MS = 10_000;

interface JobOutput {
  readonly path: string;
  readonly sha256: string;
}

interface Terminal {
  readonly ok: boolean;
  readonly outputs: JobOutput[];
  readonly code?: string;
  readonly message?: string;
}

export interface JobRun {
  readonly ok: boolean;
  readonly outputs: readonly JobOutput[];
  /** Failure code: NATIVE_TOOL_MISSING, NATIVE_TIMEOUT, NATIVE_PROTOCOL or the job's own `error` code. */
  readonly code?: string;
  readonly message?: string;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly log: string;
  readonly elapsedMs: number;
}

type ProgressSink = (event: Readonly<Record<string, unknown>>) => void;

export interface ComputeRunner {
  /** Absolute path of `llull-compute`, or null when it is not installed. */
  readonly binary: string | null;
  /** `onProgress` receives every `progress` event (parsed NDJSON record) while the job runs. */
  run(args: readonly string[], folder: string, timeoutMs: number, onProgress?: ProgressSink): Promise<JobRun>;
  /** "0.1.0" from `llull-compute --version`, or "unknown". */
  version(): Promise<string>;
}

const missing = (): JobRun => ({
  ok: false,
  outputs: [],
  code: 'NATIVE_TOOL_MISSING',
  message: nativeInstallHint('llull-compute'),
  warnings: [],
  log: '',
  elapsedMs: 0,
});

function outputsOf(value: unknown): JobOutput[] | null {
  if (!Array.isArray(value)) return null;
  const outputs: JobOutput[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry['path'] !== 'string' || typeof entry['sha256'] !== 'string') return null;
    outputs.push({ path: entry['path'], sha256: entry['sha256'] });
  }
  return outputs;
}

/** Incremental NDJSON reader of the job protocol: progress -> sink, warnings kept, the last `done` / `error` event is the terminal one. */
function createEventParser(onProgress?: ProgressSink): {
  readonly feed: (chunk: Buffer | string) => void;
  readonly end: () => void;
  readonly warnings: { code: string; message: string }[];
  readonly terminal: () => Terminal | null;
  readonly protocolError: () => string | null;
} {
  const warnings: { code: string; message: string }[] = [];
  let terminal: Terminal | null = null;
  let pending = '';
  let protocolError: string | null = null;
  const line = (text: string): void => {
    if (text.trim() === '') return;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      protocolError = `not an NDJSON event: ${text.slice(0, 200)}`;
      return;
    }
    if (!isRecord(event)) return;
    if (event['type'] === 'progress') onProgress?.(event);
    else if (event['type'] === 'warning') warnings.push({ code: String(event['code']), message: String(event['message']) });
    else if (event['type'] === 'error')
      terminal = { ok: false, outputs: [], code: String(event['code']), message: String(event['message']) };
    else if (event['type'] === 'done') {
      const outputs = outputsOf(event['outputs']);
      terminal = outputs === null ? null : { ok: event['ok'] === true, outputs };
      if (outputs === null) protocolError = 'a done event without a valid outputs list';
    }
  };
  return {
    feed(chunk) {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const text of lines) line(text);
      if (pending.length > MAX_LINE_BYTES) {
        protocolError = 'an output line longer than 1 MiB';
        pending = '';
      }
    },
    end: () => line(pending),
    warnings,
    terminal: () => terminal,
    protocolError: () => protocolError,
  };
}

/** The JobRun of a finished, killed or never started tool process and the events it printed. */
function settle(
  parser: ReturnType<typeof createEventParser>,
  run: ProcessOutcome,
  binary: string,
  timeoutMs: number,
  started: number,
): JobRun {
  parser.end();
  const base = { warnings: parser.warnings, log: run.stderr, elapsedMs: Date.now() - started };
  const fail = (code: string, message: string): JobRun => ({ ok: false, outputs: [], code, message, ...base });
  const done = parser.terminal();
  if (run.startError !== undefined) return fail('NATIVE_TOOL_MISSING', `cannot start ${binary}: ${run.startError}`);
  if (run.timedOut) return fail('NATIVE_TIMEOUT', `llull-compute timed out after ${timeoutMs} ms`);
  if (done !== null && done.ok && run.exitCode === 0) return { ok: true, outputs: done.outputs, ...base };
  if (done !== null && !done.ok) return fail(done.code ?? 'NATIVE_JOB_FAILED', done.message ?? 'the job failed');
  const reason = run.aborted ? 'an output larger than the read buffer' : parser.protocolError();
  return fail('NATIVE_PROTOCOL', reason ?? `llull-compute exited with code ${String(run.exitCode)} without a final event`);
}

async function execute(
  binary: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  onProgress?: ProgressSink,
): Promise<JobRun> {
  const started = Date.now();
  const parser = createEventParser(onProgress);
  const run = await runProcess({ executable: binary, args, cwd, env, timeoutMs, tailBytes: LOG_TAIL_BYTES, onStdout: parser.feed });
  return settle(parser, run, binary, timeoutMs, started);
}

/**
 * Blocking `execute` for the synchronous host ports (ctx.raster, ctx.pointCloud): same events, codes and tree-kill timeout.
 * `args` are given whole (the folder included); the job runs with `folder` as its working directory.
 */
export function runComputeSync(
  binary: string,
  args: readonly string[],
  folder: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  maxBuffer: number,
): JobRun {
  const started = Date.now();
  const parser = createEventParser();
  const run = runProcessSync({ executable: binary, args, cwd: folder, env, timeoutMs, maxBuffer, tailBytes: LOG_TAIL_BYTES });
  parser.feed(run.stdout);
  return settle(parser, run, binary, timeoutMs, started);
}

const versions = new Map<string, string>();
const versionIn = (probe: string): string => /llull-compute\s+(\S+)/.exec(probe)?.[1] ?? 'unknown';
const versionSpec = (binary: string): Parameters<typeof runProcess>[0] => ({
  executable: binary,
  args: ['--version'],
  env: process.env,
  timeoutMs: VERSION_TIMEOUT_MS,
  tailBytes: 4096,
});

/** "0.1.0" from `llull-compute --version`, probed once per binary (async and sync callers share the cache), or "unknown". */
async function probeVersion(binary: string): Promise<string> {
  const known = versions.get(binary);
  if (known !== undefined) return known;
  const version = versionIn((await runProcess(versionSpec(binary))).stdout);
  versions.set(binary, version);
  return version;
}

/** `probeVersion`, blocking. */
export function computeVersionSync(binary: string): string {
  const known = versions.get(binary);
  if (known !== undefined) return known;
  const version = versionIn(runProcessSync(versionSpec(binary)).stdout);
  versions.set(binary, version);
  return version;
}

export function createComputeRunner(
  env: NodeJS.ProcessEnv = process.env,
  binary: string | null = nativeBinaryPath('llull-compute', env),
): ComputeRunner {
  return {
    binary,
    run: (args, folder, timeoutMs, onProgress) =>
      binary === null ? Promise.resolve(missing()) : execute(binary, [...args, folder], folder, timeoutMs, env, onProgress),
    version: () => (binary === null ? Promise.resolve('unknown') : probeVersion(binary)),
  };
}

/** Little-endian bytes of `values` (the job format; every supported platform is little-endian, others are refused). */
export function f64Bytes(values: Float64Array): Buffer {
  if (endianness() !== 'LE') throw new Error('llull-compute job files are little-endian; this platform is not');
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

/** The reported `name` output of `run`; an Error when it was not reported or is not a plain file name. */
function reportedOutput(run: JobRun, name: string): JobOutput {
  const output = run.outputs.find((entry) => entry.path === name);
  if (output === undefined || path.basename(output.path) !== output.path) throw new Error(`llull-compute did not report output ${name}`);
  return output;
}

function checkedBytes(name: string, output: JobOutput, bytes: Buffer): Buffer {
  const actual = sha256Hex(bytes);
  if (actual !== output.sha256) throw new Error(`output ${name} hashes to ${actual}, the job reported ${output.sha256}`);
  return bytes;
}

/**
 * The bytes of output `name` of a finished run, after checking its sha256 against the `done` event.
 * @failure not listed, a path that is not a plain file name, unreadable or a hash mismatch -> Error
 */
export async function readOutput(folder: string, run: JobRun, name: string): Promise<Buffer> {
  const output = reportedOutput(run, name);
  return checkedBytes(name, output, await readFile(path.join(folder, output.path)));
}

/** `readOutput`, blocking. */
export function readOutputSync(folder: string, run: JobRun, name: string): Buffer {
  const output = reportedOutput(run, name);
  return checkedBytes(name, output, readFileSync(path.join(folder, output.path)));
}

/** `bytes` read as little-endian f64 values. */
export function f64Values(bytes: Buffer): Float64Array {
  if (bytes.length % 8 !== 0) throw new Error('an f64 output is not a whole number of values');
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Float64Array(copy.buffer);
}

const keepFolders = (env: NodeJS.ProcessEnv): boolean => env['LLULL_NATIVE_KEEP'] === '1';

/** Runs `body` in a fresh job folder with `files` written into it; the folder is removed afterwards unless LLULL_NATIVE_KEEP=1. */
export async function withJobFolder<T>(
  files: Readonly<Record<string, Buffer | string>>,
  body: (folder: string) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const folder = await mkdtemp(path.join(tmpdir(), 'llull-compute-'));
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(folder, name), content);
    return await body(folder);
  } finally {
    if (!keepFolders(env)) await rm(folder, { recursive: true, force: true });
  }
}

/** `withJobFolder`, blocking. */
export function withJobFolderSync<T>(
  files: Readonly<Record<string, Buffer | string>>,
  body: (folder: string) => T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  const folder = mkdtempSync(path.join(tmpdir(), 'llull-compute-'));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(folder, name), content);
    return body(folder);
  } finally {
    if (!keepFolders(env)) rmSync(folder, { recursive: true, force: true });
  }
}
