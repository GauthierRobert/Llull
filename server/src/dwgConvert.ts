/**
 * @layer server
 *
 * DWG -> ASCII DXF through an external converter (optional, like the Python STEP bridge). The core
 * only understands ASCII DXF (`import_dxf`); proprietary DWG bytes are converted here, then the
 * DXF text goes through the normal command path.
 *
 * Converters (tried in this order, first one installed wins):
 *   LibreDWG    `dwg2dxf -y -o <out.dxf> <in.dwg>`   env LLULL_DWG2DXF (default "dwg2dxf"; "off" disables)
 *   ODA         `<exe> <in-dir> <out-dir> ACAD2018 DXF 0 1 *.DWG`   env LLULL_ODA_CONVERTER (path)
 * Other env: LLULL_DWG_TIMEOUT_MS (default 60000), LLULL_DWG_MAX_BYTES (default 50 MB),
 *            LLULL_EXCHANGE_DIR (for the MCP tool's `path` argument).
 *
 * Safety: one private temp dir per request (removed always), argv-only spawn (no shell, fixed file
 * names — no user string reaches a command line), allowlisted child env, hard timeout, size caps.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DwgConverterPort } from '@mcp/index';
import {
  bridgeEnvironment,
  concurrencyLimiter,
  confinedPath,
  exchangeOptionsFromEnv,
  type ExchangeOptions,
} from './pythonExchange';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const MAX_DXF_BYTES = 512 * 1024 * 1024;
const MAX_CONCURRENT_CONVERSIONS = 2;
const MAX_STDERR_BYTES = 16 * 1024;

export const NO_DWG_CONVERTER_MESSAGE =
  'DWG import needs a converter on the server host: LibreDWG 0.14+ (provides dwg2dxf; the llull ' +
  'Docker image builds it, elsewhere build it from ftp.gnu.org/gnu/libredwg because distribution ' +
  'packages are often missing or outdated) or the ODA File Converter with ' +
  'LLULL_ODA_CONVERTER=<executable>. Alternatively save the drawing as ASCII DXF ' +
  '(see docs/CAD_EXCHANGE.md).';

/** HTTP-mappable conversion failure. */
export class DwgConvertError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 422 | 500 | 503 | 504,
  ) {
    super(message);
    this.name = 'DwgConvertError';
  }
}

export interface DwgConvertConfig {
  readonly dwg2dxf: string | null;
  readonly odaConverter: string | null;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly exchangeDir: string | null;
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function dwgConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DwgConvertConfig {
  const dwg2dxf = env['LLULL_DWG2DXF'] ?? 'dwg2dxf';
  const oda = env['LLULL_ODA_CONVERTER'];
  const exchangeDir = env['LLULL_EXCHANGE_DIR'];
  return {
    dwg2dxf: dwg2dxf === 'off' || dwg2dxf === '' ? null : dwg2dxf,
    odaConverter: oda !== undefined && oda !== '' && oda !== 'off' ? oda : null,
    timeoutMs: positive(env['LLULL_DWG_TIMEOUT_MS'], 60_000),
    maxBytes: positive(env['LLULL_DWG_MAX_BYTES'], DEFAULT_MAX_BYTES),
    exchangeDir: exchangeDir !== undefined && exchangeDir !== '' ? path.resolve(exchangeDir) : null,
  };
}

/** True when `bytes` start with an "AC10xx" DWG version stamp. */
export function hasDwgMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false;
  const head = Buffer.from(bytes.subarray(0, 6)).toString('latin1');
  return /^AC10\d\d$/.test(head);
}

type RunOutcome =
  | { kind: 'missing' }
  | { kind: 'timeout' }
  | { kind: 'done'; code: number | null; stderr: string };

/** Spawn `command args` (no shell); resolves, never rejects. */
function runConverter(command: string, args: string[], timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (outcome: RunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: bridgeEnvironment(),
      shell: false,
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ kind: 'timeout' });
    }, timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-MAX_STDERR_BYTES);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'EACCES') finish({ kind: 'missing' });
      else finish({ kind: 'done', code: null, stderr: error.message });
    });
    child.on('close', (code) => finish({ kind: 'done', code, stderr: stderr.toString('utf8') }));
  });
}

async function readDxfIn(dir: string, preferred: string): Promise<string | null> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const name = names.includes(preferred)
    ? preferred
    : names.find((entry) => entry.toLowerCase().endsWith('.dxf'));
  if (name === undefined) return null;
  const file = path.join(dir, name);
  const info = await stat(file);
  if (info.size === 0) return null;
  if (info.size > MAX_DXF_BYTES) {
    throw new DwgConvertError('The converted DXF is too large to import.', 413);
  }
  return readFile(file, 'utf8');
}

/**
 * Convert DWG bytes to ASCII DXF text.
 * @failure bad magic -> 400; too big -> 413; no converter installed -> 503; timeout -> 504;
 *          converter failure -> 422
 */
export async function convertDwgToDxf(
  bytes: Uint8Array,
  config: DwgConvertConfig = dwgConfigFromEnv(),
): Promise<string> {
  if (bytes.length > config.maxBytes) {
    throw new DwgConvertError(
      `DWG file is ${bytes.length} bytes; the limit is ${config.maxBytes} bytes (LLULL_DWG_MAX_BYTES).`,
      413,
    );
  }
  if (!hasDwgMagic(bytes)) {
    throw new DwgConvertError(
      'Not a DWG file: expected the "AC10xx" version header (is it a DXF? use import_dxf).',
      400,
    );
  }
  if (config.dwg2dxf === null && config.odaConverter === null) {
    throw new DwgConvertError(NO_DWG_CONVERTER_MESSAGE, 503);
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'llull-dwg-'));
  try {
    const inDir = path.join(dir, 'in');
    const outDir = path.join(dir, 'out');
    await mkdir(inDir);
    await mkdir(outDir);
    await writeFile(path.join(inDir, 'input.dwg'), bytes);
    const attempts: Array<{ command: string; args: string[] }> = [];
    if (config.dwg2dxf !== null) {
      attempts.push({
        command: config.dwg2dxf,
        args: ['-y', '-o', path.join(outDir, 'input.dxf'), path.join(inDir, 'input.dwg')],
      });
    }
    if (config.odaConverter !== null) {
      attempts.push({
        command: config.odaConverter,
        args: [inDir, outDir, 'ACAD2018', 'DXF', '0', '1', '*.DWG'],
      });
    }
    for (const attempt of attempts) {
      const outcome = await runConverter(attempt.command, attempt.args, config.timeoutMs);
      if (outcome.kind === 'missing') continue;
      if (outcome.kind === 'timeout') {
        throw new DwgConvertError(
          `DWG conversion timed out after ${config.timeoutMs} ms (LLULL_DWG_TIMEOUT_MS).`,
          504,
        );
      }
      const text = await readDxfIn(outDir, 'input.dxf');
      if (text !== null) return text;
      const detail = outcome.stderr.trim().slice(-1000);
      throw new DwgConvertError(
        `DWG conversion failed (exit ${String(outcome.code)}): ${detail || 'no DXF produced'}`,
        422,
      );
    }
    throw new DwgConvertError(NO_DWG_CONVERTER_MESSAGE, 503);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The MCP-facing port; null when both converters are disabled. */
export function createDwgConverterPort(
  env: NodeJS.ProcessEnv = process.env,
): DwgConverterPort | null {
  const config = dwgConfigFromEnv(env);
  if (config.dwg2dxf === null && config.odaConverter === null) return null;
  const limit = concurrencyLimiter(MAX_CONCURRENT_CONVERSIONS);
  const root = config.exchangeDir;
  return {
    convertDwg: (dwgBase64) =>
      limit(() => convertDwgToDxf(Buffer.from(dwgBase64, 'base64'), config)),
    ...(root !== null
      ? {
          readExchangeFile: async (relative: string): Promise<string> =>
            (await readFile(await confinedPath(root, relative, 'read'))).toString('base64'),
        }
      : {}),
  };
}

/** STEP/code exchange options plus the DWG converter, from the environment. */
export function exchangeOptionsWithDwg(env: NodeJS.ProcessEnv = process.env): ExchangeOptions {
  return { ...exchangeOptionsFromEnv(env), dwg: createDwgConverterPort(env) };
}
