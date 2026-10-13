/**
 * `CadExchangePort` over one short-lived Python process per request (server/python/llull_bridge.py, CadQuery /
 * build123d): no shared state, a hard timeout, script stdout kept out of the JSON response. Environment:
 *   LLULL_PYTHON              python with CadQuery (default "python3"; "off" disables the bridge)
 *   LLULL_PYTHON_BUILD123D    python with build123d (default: LLULL_PYTHON)
 *   LLULL_PYTHON_TIMEOUT_MS   per-request timeout (default 120000)
 *   LLULL_PYTHON_QUEUE_MAX    requests allowed to wait for a free slot (default 16); more -> "busy" error (REST 503)
 *   LLULL_EXCHANGE_DIR        directory that tool `path` arguments resolve inside (optional)
 *   LLULL_ALLOW_CODE_EXECUTION=1   enables import_code (arbitrary Python execution)
 */

import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { PythonBackend } from '@core/codegen/pythonRuntime';
import type { CadExchangePort, DwgConverterPort, ProgramRun } from '@mcp/index';
import { exchangeDirOf, positiveInteger } from './env';
import { trackChild } from './childProcesses';

const MAX_OUTPUT_BYTES = 128 * 1024 * 1024; // JSON.parse'd in memory; ~96 MB of base64 STEP
const MAX_STDERR_BYTES = 64 * 1024; // tail kept for error messages
const MAX_CONCURRENT_RUNS = 2; // CadQuery processes are heavy; the rest queue
const DEFAULT_QUEUE_MAX = 16;

/** Environment the Python child may see — never the server's secrets. */
const ENV_ALLOWLIST =
  /^(PATH|HOME|USER|LOGNAME|LANG|LC_\w+|TZ|TMPDIR|TEMP|TMP|SYSTEMROOT|COMSPEC|PYTHON\w*|VIRTUAL_ENV|CONDA_\w+|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH|CASROOT)$/;

export function bridgeEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => ENV_ALLOWLIST.test(key)));
}

/** STEP / code exchange wiring injected into each MCP server; `dwg` = DWG -> DXF converter. */
export interface ExchangeOptions {
  readonly port: CadExchangePort | null;
  readonly dwg?: DwgConverterPort | null;
  readonly allowCodeExecution: boolean;
}

export interface PythonExchangeConfig {
  readonly python: string;
  readonly build123dPython: string;
  readonly timeoutMs: number;
  readonly bridgeScript: string;
  readonly exchangeDir: string | null;
}

interface BridgeResponse {
  ok: boolean;
  error?: string;
  log?: string;
  [key: string]: unknown;
}

/** null when the bridge is disabled (`LLULL_PYTHON=off`). */
export function pythonExchangeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PythonExchangeConfig | null {
  const python = env['LLULL_PYTHON'] ?? 'python3';
  if (python === 'off') return null;
  return {
    python,
    build123dPython: env['LLULL_PYTHON_BUILD123D'] ?? python,
    timeoutMs: positiveInteger(env['LLULL_PYTHON_TIMEOUT_MS'], 120_000),
    bridgeScript: path.resolve(__dirname, '../python/llull_bridge.py'),
    exchangeDir: exchangeDirOf(env),
  };
}

export function codeExecutionAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['LLULL_ALLOW_CODE_EXECUTION'] === '1';
}

/** Keep the last `maxBytes` of a child's stderr; the getter returns them as UTF-8. */
export function captureStderrTail(stderr: Readable, maxBytes: number): () => string {
  let tail = Buffer.alloc(0);
  stderr.on('data', (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk]).subarray(-maxBytes);
  });
  return () => tail.toString('utf8');
}

export function callBridge(
  python: string,
  bridgeScript: string,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    const child = trackChild(spawn(python, [bridgeScript], { stdio: ['pipe', 'pipe', 'pipe'], env: bridgeEnvironment() }));
    const stdout: Buffer[] = [];
    const stderr = captureStderrTail(child.stderr, MAX_STDERR_BYTES);
    let size = 0;
    let settled = false;
    const finish = (error: Error | null, value?: BridgeResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== null) reject(error);
      else resolve(value as BridgeResponse);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Python bridge timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error(`Python bridge output exceeded ${MAX_OUTPUT_BYTES / 1024 / 1024} MB`));
        return;
      }
      stdout.push(chunk);
    });
    child.on('error', (error) =>
      finish(new Error(`cannot start Python "${python}": ${error.message}. Set LLULL_PYTHON to a python with CadQuery.`)),
    );
    child.on('close', (code) => {
      try {
        finish(null, JSON.parse(Buffer.concat(stdout).toString('utf8')) as BridgeResponse);
      } catch {
        finish(new Error(`Python bridge exited with code ${String(code)} without a response. ${stderr().trim().slice(-2000)}`));
      }
    });
    child.stdin.on('error', () => undefined); // the close handler reports the failure
    child.stdin.end(JSON.stringify(request));
  });
}

function bridgeError(response: BridgeResponse): Error {
  const error = response.error ?? 'unknown error';
  const hint = /No module named '?(cadquery|build123d|OCP)/.test(error)
    ? ' Install it with `pip install cadquery` (or build123d) for the configured LLULL_PYTHON.'
    : '';
  return new Error(`${error}${hint}`);
}

/** Resolve `relative` strictly inside `root` (no absolute paths, no `..` escape). */
export function resolveInside(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  const fromRoot = path.relative(root, resolved);
  if (path.isAbsolute(relative) || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
    throw new Error(`path "${relative}" must stay inside the exchange directory`);
  }
  return resolved;
}

/** `resolveInside`, re-checked after following symlinks; writes refuse an existing symlink target. */
export async function confinedPath(root: string, relative: string, mode: 'read' | 'write'): Promise<string> {
  const target = resolveInside(root, relative);
  const realRoot = await realpath(root);
  const checked = mode === 'read' ? await realpath(target) : await realpath(path.dirname(target));
  const fromRealRoot = path.relative(realRoot, checked);
  if (fromRealRoot.startsWith('..') || path.isAbsolute(fromRealRoot)) {
    throw new Error(`path "${relative}" resolves outside the exchange directory (symbolic link)`);
  }
  if (mode === 'write' && (await lstat(target).catch(() => null))?.isSymbolicLink() === true) {
    throw new Error(`path "${relative}" is a symbolic link; refusing to overwrite it`);
  }
  return target;
}

export const PYTHON_BUSY_MESSAGE = 'Python bridge is busy (queue full), retry later.';

/** Thrown by a bounded limiter when its queue is full; REST maps it to 503. */
export class BusyError extends Error {
  constructor(message: string = PYTHON_BUSY_MESSAGE) {
    super(message);
    this.name = 'BusyError';
  }
}

/** A FIFO limiter: at most `limit` tasks in flight, at most `maxQueue` waiting (default unbounded; more -> `BusyError`). */
export function concurrencyLimiter(limit: number, maxQueue: number = Infinity): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      if (waiting.length >= maxQueue) throw new BusyError();
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export function createPythonExchangePort(config: PythonExchangeConfig): CadExchangePort {
  const limit = concurrencyLimiter(MAX_CONCURRENT_RUNS, positiveInteger(process.env['LLULL_PYTHON_QUEUE_MAX'], DEFAULT_QUEUE_MAX));
  const run = async (language: PythonBackend | 'step', request: Record<string, unknown>): Promise<BridgeResponse> => {
    const python = language === 'build123d' ? config.build123dPython : config.python;
    const response = await limit(() => callBridge(python, config.bridgeScript, request, config.timeoutMs));
    if (!response.ok) throw bridgeError(response);
    return response;
  };

  const port: CadExchangePort = {
    async runProgram({ language, source, step }): Promise<ProgramRun> {
      const response = await run(language, { op: 'run', language, source, step });
      return {
        trace: response['trace'],
        traced: response['traced'] === true,
        log: typeof response.log === 'string' ? response.log : '',
        ...(typeof response['stepBase64'] === 'string' ? { stepBase64: response['stepBase64'] } : {}),
      };
    },
    async importStep(stepBase64): Promise<{ bodies: unknown[] }> {
      const response = await run('step', { op: 'import_step', stepBase64 });
      const bodies = response['bodies'];
      if (!Array.isArray(bodies)) throw new Error('Python bridge returned no bodies');
      return { bodies };
    },
  };

  const root = config.exchangeDir;
  if (root === null) return port;
  return {
    ...port,
    async readExchangeFile(relative, encoding): Promise<string> {
      return readFile(await confinedPath(root, relative, 'read'), encoding);
    },
    async writeExchangeFile(fileName, base64): Promise<string> {
      await mkdir(root, { recursive: true });
      const target = await confinedPath(root, fileName, 'write');
      await writeFile(target, Buffer.from(base64, 'base64'));
      return target;
    },
  };
}

export function exchangeOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ExchangeOptions {
  const config = pythonExchangeConfigFromEnv(env);
  return { port: config === null ? null : createPythonExchangePort(config), allowCodeExecution: codeExecutionAllowed(env) };
}
