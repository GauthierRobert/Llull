/**
 * `mtest_run` — the optional MFront / MTest transport (PHY-02 FR-MATL-23, OQ-MATL-05: not bundled, user-installed separate executables).
 * Runs an MTest script (optionally compiling an MFront behaviour first) in a temporary job folder and returns the result table as query
 * data. It never changes the document. The tools are found at runtime (`mtestProcess.ts`); when absent the answer is a coded refusal with the
 * reason, and `probe: true` reports availability without running anything. Compiling and loading a behaviour executes native code, so a
 * run needs LLULL_ALLOW_CODE_EXECUTION=1 (the same switch as import_code).
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CommandOutcome } from '@protocol/restProtocol';
import { isRecord } from '@lib/isRecord';
import { nonEmptyString } from '@lib/nonEmptyString';
import { codeExecutionAllowed } from '../pythonExchange';
import { mfrontTools, spawnRunner, toolEnvironment, type MfrontTools, type ProcessRunner } from './mtestProcess';
import { parseMtestResult } from './mtestResult';

export const MTEST_TOOL = 'mtest_run';
const DEFAULT_TIMEOUT_S = 120;
const BEHAVIOUR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const LIBRARY_TOKEN = '{{library}}';

export interface MtestDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly runner?: ProcessRunner;
  readonly tools?: MfrontTools;
}

const outcome = (isError: boolean, summary: string, data: unknown, code?: string, remediation?: string): CommandOutcome => ({
  summary,
  affected: [],
  isError,
  changed: false,
  data,
  ...(code !== undefined ? { error: { code, ids: [], paths: [], remediation: remediation ?? '' } } : {}),
});

const refusal = (code: string, message: string, data: Record<string, unknown> = {}, remediation?: string): CommandOutcome =>
  outcome(true, `${MTEST_TOOL}: ${code} — ${message}`, { code, ...data }, code, remediation);

const libraryExtension = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'dll' : platform === 'darwin' ? 'dylib' : 'so');

/** The library the build produced in `src/` (lib<name>.<ext> | <name>.dll); the conventional lib<name> path when none is found. */
async function builtLibrary(folder: string, library: string, platform: NodeJS.Platform): Promise<string> {
  const extension = libraryExtension(platform);
  const candidates = [`lib${library}.${extension}`, `${library}.${extension}`];
  const present = await readdir(path.join(folder, 'src')).catch(() => [] as string[]);
  return `src/${candidates.find((file) => present.includes(file)) ?? candidates[0] ?? ''}`;
}

/**
 * @failure tools absent -> MFRONT_TOOL_MISSING (reason in the message and data.reason); code execution not allowed ->
 *   MFRONT_CODE_EXECUTION_DISABLED; bad params -> MTEST_PARAMS_INVALID; mfront / mtest non-zero exit -> MFRONT_BUILD_FAILED / MTEST_FAILED
 *   (log tail in data.log); timeout -> MTEST_TIMEOUT; no parsable .res -> MTEST_RESULT_MISSING. Never throws for these.
 */
export async function runMtestTool(params: unknown, deps: MtestDeps = {}): Promise<CommandOutcome> {
  const env = deps.env ?? process.env;
  const tools = deps.tools ?? mfrontTools(env);
  const args = isRecord(params) ? params : {};
  if (args['probe'] === true) {
    return outcome(
      false,
      tools.mtest !== null
        ? `${MTEST_TOOL}: mtest at ${tools.mtest}; mfront ${tools.mfront ?? 'not found'}${tools.reason !== null ? ` (${tools.reason})` : ''}`
        : `${MTEST_TOOL}: not available — ${tools.reason ?? 'mtest not found'}`,
      {
        available: tools.mtest !== null,
        mtest: tools.mtest,
        mfront: tools.mfront,
        reason: tools.reason,
        codeExecutionAllowed: codeExecutionAllowed(env),
      },
    );
  }
  const script = nonEmptyString(args['mtest']);
  if (script === undefined) return refusal('MTEST_PARAMS_INVALID', 'give mtest, the text of the MTest script');
  const mfront = isRecord(args['mfront']) ? args['mfront'] : undefined;
  const name = mfront === undefined ? undefined : nonEmptyString(mfront['name']);
  const source = mfront === undefined ? undefined : nonEmptyString(mfront['source']);
  const library = (mfront === undefined ? undefined : nonEmptyString(mfront['library'])) ?? 'Behaviour';
  if (
    args['mfront'] !== undefined &&
    (name === undefined || source === undefined || !BEHAVIOUR_NAME.test(name) || !BEHAVIOUR_NAME.test(library))
  )
    return refusal('MTEST_PARAMS_INVALID', 'mfront needs name and source; name and library are identifiers (letters, digits, underscore)');
  if (tools.mtest === null || (mfront !== undefined && tools.mfront === null))
    return refusal(
      'MFRONT_TOOL_MISSING',
      tools.reason ?? 'mtest not found',
      { reason: tools.reason, mtest: tools.mtest, mfront: tools.mfront },
      'install TFEL / MFront and set LLULL_MTEST (and LLULL_MFRONT): llull does not bundle it',
    );
  if (!codeExecutionAllowed(env))
    return refusal(
      'MFRONT_CODE_EXECUTION_DISABLED',
      'running MFront / MTest compiles and loads native code and is disabled: start with LLULL_ALLOW_CODE_EXECUTION=1 (only on a machine you trust)',
    );
  const runner = deps.runner ?? spawnRunner;
  const timeoutMs =
    (typeof args['timeoutS'] === 'number' && Number.isFinite(args['timeoutS'])
      ? Math.max(1, Math.min(86_400, args['timeoutS']))
      : DEFAULT_TIMEOUT_S) * 1000;
  const processEnv = toolEnvironment(env);
  const folder = await mkdtemp(path.join(tmpdir(), 'llull-mtest-'));
  try {
    const log: string[] = [];
    if (mfront !== undefined && name !== undefined && source !== undefined && tools.mfront !== null) {
      await writeFile(path.join(folder, `${name}.mfront`), source);
      const built = await runner.run(tools.mfront, ['--obuild', '--interface=generic', `${name}.mfront`], folder, timeoutMs, processEnv);
      log.push(built.log);
      if (built.startError !== undefined)
        return refusal('MFRONT_TOOL_MISSING', `cannot start mfront: ${built.startError}`, { reason: built.startError });
      if (built.timedOut) return refusal('MTEST_TIMEOUT', `mfront timed out after ${timeoutMs} ms`, { log: built.log });
      if (built.exitCode !== 0)
        return refusal(
          'MFRONT_BUILD_FAILED',
          `mfront exited with code ${String(built.exitCode)}`,
          { log: built.log },
          'fix the .mfront source; the log tail is in data.log',
        );
    }
    const text = script.split(LIBRARY_TOKEN).join(await builtLibrary(folder, library, process.platform));
    await writeFile(path.join(folder, 'job.mtest'), text);
    const ran = await runner.run(tools.mtest, ['job.mtest'], folder, timeoutMs, processEnv);
    log.push(ran.log);
    if (ran.startError !== undefined)
      return refusal('MFRONT_TOOL_MISSING', `cannot start mtest: ${ran.startError}`, { reason: ran.startError });
    if (ran.timedOut) return refusal('MTEST_TIMEOUT', `mtest timed out after ${timeoutMs} ms`, { log: ran.log });
    if (ran.exitCode !== 0)
      return refusal(
        'MTEST_FAILED',
        `mtest exited with code ${String(ran.exitCode)}`,
        { log: ran.log },
        'check the script; the log tail is in data.log',
      );
    const resultFile = (await readdir(folder)).find((file) => file.endsWith('.res'));
    const parsed = resultFile === undefined ? null : parseMtestResult(await readFile(path.join(folder, resultFile), 'utf8'));
    if (parsed === null)
      return refusal(
        'MTEST_RESULT_MISSING',
        'mtest finished but wrote no parsable .res result file',
        { log: ran.log },
        'add output of the result file to the script',
      );
    return outcome(
      false,
      `${MTEST_TOOL}: ${parsed.rowCount} row(s), ${parsed.columns.length} column(s)${parsed.truncated ? ` (first ${parsed.rows.length} returned)` : ''}; ` +
        'results come from an external MFront / MTest install and are not llull-validated',
      {
        columns: parsed.columns,
        rows: parsed.rows,
        rowCount: parsed.rowCount,
        truncated: parsed.truncated,
        mtest: tools.mtest,
        log: log.join('\n').slice(-4000),
      },
    );
  } finally {
    if (env['LLULL_NATIVE_KEEP'] !== '1') await rm(folder, { recursive: true, force: true });
  }
}
