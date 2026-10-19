/**
 * `llull-compute` job runner (RS1 §2): one tracked child per job in a temporary job folder, hard timeout, NDJSON events parsed from stdout
 * (progress / warning / done / error), last 64 KB of stderr kept, outputs re-hashed before they are read. Modelled on `fea/ccxProcess.ts`.
 * Missing binary -> NATIVE_TOOL_MISSING with the install hint (llull stays usable: the TypeScript paths remain).
 * Environment: LLULL_COMPUTE (binary override), LLULL_NATIVE_DIR (bundle), LLULL_NATIVE_KEEP=1 (keep job folders), RAYON_NUM_THREADS.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { endianness, tmpdir } from 'node:os';
import path from 'node:path';
import { isRecord } from '@lib/isRecord';
import { captureStderrTail } from '../pythonExchange';
import { trackChild } from '../childProcesses';
import { nativeBinaryPath, nativeInstallHint } from './nativeBinary';

const LOG_TAIL_BYTES = 64 * 1024;
/** Named guard: longest stdout line accepted from the binary (an event is a few hundred bytes). */
const MAX_LINE_BYTES = 1024 * 1024;

interface JobOutput {
  readonly path: string;
  readonly sha256: string;
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

function execute(
  binary: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  onProgress?: ProgressSink,
): Promise<JobRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = trackChild(spawn(binary, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }));
    const stderr = captureStderrTail(child.stderr, LOG_TAIL_BYTES);
    const warnings: { code: string; message: string }[] = [];
    let terminal: { ok: boolean; outputs: JobOutput[]; code?: string; message?: string } | null = null;
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
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const text of lines) line(text);
      if (pending.length > MAX_LINE_BYTES) {
        protocolError = 'an output line longer than 1 MiB';
        pending = '';
      }
    });
    let timedOut = false;
    let settled = false;
    const finish = (run: Omit<JobRun, 'elapsedMs' | 'warnings' | 'log'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...run, warnings, log: stderr(), elapsedMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) =>
      finish({ ok: false, outputs: [], code: 'NATIVE_TOOL_MISSING', message: `cannot start ${binary}: ${error.message}` }),
    );
    child.on('close', (exitCode) => {
      line(pending);
      const done = terminal as { ok: boolean; outputs: JobOutput[]; code?: string; message?: string } | null;
      if (timedOut) finish({ ok: false, outputs: [], code: 'NATIVE_TIMEOUT', message: `llull-compute timed out after ${timeoutMs} ms` });
      else if (done !== null && done.ok && exitCode === 0) finish({ ok: true, outputs: done.outputs });
      else if (done !== null && !done.ok)
        finish({ ok: false, outputs: [], code: done.code ?? 'NATIVE_JOB_FAILED', message: done.message ?? 'the job failed' });
      else
        finish({
          ok: false,
          outputs: [],
          code: 'NATIVE_PROTOCOL',
          message: protocolError ?? `llull-compute exited with code ${String(exitCode)} without a final event`,
        });
    });
  });
}

export function createComputeRunner(
  env: NodeJS.ProcessEnv = process.env,
  binary: string | null = nativeBinaryPath('llull-compute', env),
): ComputeRunner {
  let version: string | null = null;
  return {
    binary,
    run: (args, folder, timeoutMs, onProgress) =>
      binary === null ? Promise.resolve(missing()) : execute(binary, [...args, folder], folder, timeoutMs, env, onProgress),
    async version() {
      if (version !== null) return version;
      if (binary === null) return 'unknown';
      const probe = await new Promise<string>((resolve) => {
        const child = trackChild(spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }));
        const out = captureStderrTail(child.stdout, 4096);
        child.on('error', () => resolve(''));
        child.on('close', () => resolve(out()));
      });
      version = /llull-compute\s+(\S+)/.exec(probe)?.[1] ?? 'unknown';
      return version;
    },
  };
}

/** Little-endian bytes of `values` (the job format; every supported platform is little-endian, others are refused). */
export function f64Bytes(values: Float64Array): Buffer {
  if (endianness() !== 'LE') throw new Error('llull-compute job files are little-endian; this platform is not');
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

/**
 * The bytes of output `name` of a finished run, after checking its sha256 against the `done` event.
 * @failure not listed, a path that is not a plain file name, unreadable or a hash mismatch -> Error
 */
export async function readOutput(folder: string, run: JobRun, name: string): Promise<Buffer> {
  const output = run.outputs.find((entry) => entry.path === name);
  if (output === undefined || path.basename(output.path) !== output.path) throw new Error(`llull-compute did not report output ${name}`);
  const bytes = await readFile(path.join(folder, output.path));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== output.sha256) throw new Error(`output ${name} hashes to ${actual}, the job reported ${output.sha256}`);
  return bytes;
}

/** `bytes` read as little-endian f64 values. */
export function f64Values(bytes: Buffer): Float64Array {
  if (bytes.length % 8 !== 0) throw new Error('an f64 output is not a whole number of values');
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Float64Array(copy.buffer);
}

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
    if (env['LLULL_NATIVE_KEEP'] !== '1') await rm(folder, { recursive: true, force: true });
  }
}
