/**
 * @layer server
 *
 * `CadExchangePort` backed by a Python child process (server/python/llull_bridge.py) running
 * CadQuery / build123d on OpenCascade. One short-lived process per request: no shared state,
 * a hard timeout, and script stdout kept out of the JSON response.
 *
 * Environment:
 *   LLULL_PYTHON              python with CadQuery (default "python3"; "off" disables the bridge)
 *   LLULL_PYTHON_BUILD123D    python with build123d (default: LLULL_PYTHON)
 *   LLULL_PYTHON_TIMEOUT_MS   per-request timeout (default 120000)
 *   LLULL_EXCHANGE_DIR        directory that tool `path` arguments resolve inside (optional)
 *   LLULL_ALLOW_CODE_EXECUTION=1   enables import_code (arbitrary Python execution)
 */

import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CadExchangePort, ProgramRun, PythonLanguage } from '@mcp/index';

/** Response size cap (it is JSON.parse'd in memory). ~96 MB of STEP once base64-encoded. */
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
/** Only the tail of stderr is kept for error messages. */
const MAX_STDERR_BYTES = 64 * 1024;
/** CadQuery processes are heavy; at most this many run at once, the rest queue. */
const MAX_CONCURRENT_RUNS = 2;

/** Environment variables the Python child may see — never the server's secrets (tokens, keys). */
const ENV_ALLOWLIST =
  /^(PATH|HOME|USER|LOGNAME|LANG|LC_\w+|TZ|TMPDIR|TEMP|TMP|SYSTEMROOT|COMSPEC|PYTHON\w*|VIRTUAL_ENV|CONDA_\w+|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH|CASROOT)$/;

/** The subset of `env` passed to the bridge process. */
export function bridgeEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => ENV_ALLOWLIST.test(key)));
}

/** STEP / parametric-code exchange wiring (Python bridge), injected into each MCP server. */
export interface ExchangeOptions {
  readonly port: CadExchangePort | null;
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

/** Resolve the exchange config from the environment; null when the bridge is disabled. */
export function pythonExchangeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PythonExchangeConfig | null {
  const python = env['LLULL_PYTHON'] ?? 'python3';
  if (python === 'off') return null;
  const timeout = Number(env['LLULL_PYTHON_TIMEOUT_MS']);
  const exchangeDir = env['LLULL_EXCHANGE_DIR'];
  return {
    python,
    build123dPython: env['LLULL_PYTHON_BUILD123D'] ?? python,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 120_000,
    bridgeScript: path.resolve(__dirname, '../python/llull_bridge.py'),
    exchangeDir: exchangeDir !== undefined && exchangeDir !== '' ? path.resolve(exchangeDir) : null,
  };
}

export function codeExecutionAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['LLULL_ALLOW_CODE_EXECUTION'] === '1';
}

/** Run the bridge once with a JSON request; resolves with its parsed response. */
export function callBridge(
  python: string,
  bridgeScript: string,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [bridgeScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: bridgeEnvironment(),
    });
    const stdout: Buffer[] = [];
    let stderr = Buffer.alloc(0);
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
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-MAX_STDERR_BYTES);
    });
    child.on('error', (error) => {
      finish(
        new Error(
          `cannot start Python "${python}": ${error.message}. Set LLULL_PYTHON to a python with CadQuery.`,
        ),
      );
    });
    child.on('close', (code) => {
      const text = Buffer.concat(stdout).toString('utf8');
      try {
        finish(null, JSON.parse(text) as BridgeResponse);
      } catch {
        const detail = stderr.toString('utf8').trim().slice(-2000);
        finish(
          new Error(`Python bridge exited with code ${String(code)} without a response. ${detail}`),
        );
      }
    });
    child.stdin.on('error', () => {
      /* the close handler reports the failure */
    });
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

/**
 * Resolve `relative` inside `root` and re-check after following symlinks, so a link placed in the
 * exchange directory cannot read or write outside it. Writes refuse an existing symlink target.
 */
async function confinedPath(
  root: string,
  relative: string,
  mode: 'read' | 'write',
): Promise<string> {
  const target = resolveInside(root, relative);
  const realRoot = await realpath(root);
  const checked = mode === 'read' ? await realpath(target) : await realpath(path.dirname(target));
  const fromRealRoot = path.relative(realRoot, checked);
  if (fromRealRoot.startsWith('..') || path.isAbsolute(fromRealRoot)) {
    throw new Error(`path "${relative}" resolves outside the exchange directory (symbolic link)`);
  }
  if (mode === 'write') {
    const existing = await lstat(target).catch(() => null);
    if (existing?.isSymbolicLink() === true) {
      throw new Error(`path "${relative}" is a symbolic link; refusing to overwrite it`);
    }
  }
  return target;
}

/** A FIFO limiter: at most `limit` tasks in flight. */
function concurrencyLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
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
  const limit = concurrencyLimiter(MAX_CONCURRENT_RUNS);
  const run = async (
    language: PythonLanguage | 'step',
    request: Record<string, unknown>,
  ): Promise<BridgeResponse> => {
    const python = language === 'build123d' ? config.build123dPython : config.python;
    const response = await limit(() =>
      callBridge(python, config.bridgeScript, request, config.timeoutMs),
    );
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
        ...(typeof response['stepBase64'] === 'string'
          ? { stepBase64: response['stepBase64'] }
          : {}),
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
      const target = await confinedPath(root, relative, 'read');
      return readFile(target, encoding === 'base64' ? 'base64' : 'utf8');
    },
    async writeExchangeFile(fileName, base64): Promise<string> {
      await mkdir(root, { recursive: true });
      const target = await confinedPath(root, fileName, 'write');
      await writeFile(target, Buffer.from(base64, 'base64'));
      return target;
    },
  };
}

/** Exchange options from the environment (LLULL_PYTHON, LLULL_ALLOW_CODE_EXECUTION, ...). */
export function exchangeOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ExchangeOptions {
  const config = pythonExchangeConfigFromEnv(env);
  return {
    port: config === null ? null : createPythonExchangePort(config),
    allowCodeExecution: codeExecutionAllowed(env),
  };
}
