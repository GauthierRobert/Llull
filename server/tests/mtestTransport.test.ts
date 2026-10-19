/**
 * The optional MFront / MTest transport (PHY-02 OQ-MATL-05: not bundled, user-installed executables). Detection, refusals and the job flow
 * are proven with an injected process runner; the real `mtest` run is skipped with a logged reason when no MTest is installed.
 */

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exchangeToolDefinitions } from '../src/cli/exchange';
import { mfrontTools, spawnRunner, toolEnvironment, type ProcessResult, type ProcessRunner } from '../src/mfront/mtestProcess';
import { MAX_RESULT_ROWS, parseMtestResult } from '../src/mfront/mtestResult';
import { runMtestTool } from '../src/mfront/mtestTool';
import { runNativeTool } from '../src/native/tools';

const FOUND = { mtest: '/opt/tfel/bin/mtest', mfront: '/opt/tfel/bin/mfront', reason: null } as const;
const ALLOWED = { LLULL_ALLOW_CODE_EXECUTION: '1' } as NodeJS.ProcessEnv;
const RES = ['# first column : Time', '# 2nd column : EXX', '# 3rd column : SXX', '0 0 0', '1 0.01 2.5e+06', '2 0.02 5e6', ''].join('\n');

interface Call {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly files: string[];
  readonly script: string | null;
}

/** A runner that records each call and plays `behaviour`; the mtest call may write a result file into the job folder. */
function fakeRunner(behaviour: (call: Call) => Promise<ProcessResult> | ProcessResult, calls: Call[] = []): ProcessRunner {
  return {
    run: async (executable, args, cwd) => {
      const { readdirSync } = await import('node:fs');
      const files = readdirSync(cwd);
      const script = files.includes('job.mtest') ? readFileSync(path.join(cwd, 'job.mtest'), 'utf8') : null;
      const call: Call = { executable, args, cwd, files, script };
      calls.push(call);
      return behaviour(call);
    },
  };
}

const ok: ProcessResult = { exitCode: 0, log: 'done', timedOut: false };

describe('detection', () => {
  const exists = (files: string[]) => (file: string) => files.includes(file.replaceAll('\\', '/'));

  it('finds the tools from the environment variables first', () => {
    const tools = mfrontTools(
      { LLULL_MTEST: '/a/mtest', LLULL_MFRONT: '/a/mfront', PATH: '/usr/bin' },
      exists(['/a/mtest', '/a/mfront']),
      'linux',
    );
    expect(tools).toMatchObject({ reason: null });
    expect(tools.mtest?.replaceAll('\\', '/')).toMatch(/\/a\/mtest$/);
  });

  it('falls back to the PATH and honours PATHEXT on Windows', () => {
    const tools = mfrontTools({ PATH: '/tfel/bin', PATHEXT: '.EXE;.CMD' }, exists(['/tfel/bin/mtest.exe']), 'win32');
    expect(tools.mtest?.replaceAll('\\', '/')).toMatch(/tfel\/bin\/mtest\.exe$/);
    expect(tools.mfront).toBeNull();
  });

  it('reports why a tool is missing, never throws, and says llull does not bundle it', () => {
    const none = mfrontTools({ PATH: '/usr/bin' }, () => false, 'linux');
    expect(none).toMatchObject({ mtest: null, mfront: null });
    expect(none.reason).toContain('does not bundle');
    const wrong = mfrontTools({ LLULL_MTEST: '/nope/mtest' }, () => false, 'linux');
    expect(wrong.reason).toContain('LLULL_MTEST=/nope/mtest does not exist');
  });

  it('keeps credentials out of the tool environment', () => {
    const env = toolEnvironment({ PATH: '/bin', GITHUB_TOKEN: 'x', MY_SECRET: 'y', CXX: 'g++' });
    expect(Object.keys(env).sort()).toEqual(['CXX', 'PATH']);
  });
});

describe('result parser', () => {
  it('reads named columns and rows', () => {
    const parsed = parseMtestResult(RES);
    expect(parsed).toMatchObject({ columns: ['Time', 'EXX', 'SXX'], rowCount: 3, truncated: false });
    expect(parsed?.rows[1]).toEqual([1, 0.01, 2.5e6]);
  });

  it('truncates long files and rejects malformed ones', () => {
    const long = Array.from({ length: MAX_RESULT_ROWS + 5 }, (_, i) => `${i} ${i}`).join('\n');
    const parsed = parseMtestResult(long);
    expect(parsed?.rows).toHaveLength(MAX_RESULT_ROWS);
    expect(parsed).toMatchObject({ rowCount: MAX_RESULT_ROWS + 5, truncated: true, columns: ['column1', 'column2'] });
    expect(parseMtestResult('# only comments')).toBeNull();
    expect(parseMtestResult('1 2\n3')).toBeNull();
    expect(parseMtestResult('1 x')).toBeNull();
  });
});

describe('mtest_run', () => {
  it('is a registered native tool with a schema', () => {
    const definition = exchangeToolDefinitions().find((tool) => tool.name === 'mtest_run');
    expect(definition?.inputSchema).toBeDefined();
    expect(definition?.description).toContain('not bundled');
  });

  it('probe reports availability without running anything', async () => {
    const missing = await runMtestTool({ probe: true }, { env: {}, tools: { mtest: null, mfront: null, reason: 'mtest not found: …' } });
    expect(missing).toMatchObject({ isError: false, changed: false, data: { available: false, reason: 'mtest not found: …' } });
    const found = await runMtestTool({ probe: true }, { env: ALLOWED, tools: FOUND });
    expect(found.data).toMatchObject({ available: true, mtest: FOUND.mtest, codeExecutionAllowed: true });
  });

  it('refuses with MFRONT_TOOL_MISSING and the reason when the tools are absent (the clean skip)', async () => {
    const result = await runMtestTool(
      { mtest: '@Times {0, 1};' },
      { env: ALLOWED, tools: { mtest: null, mfront: null, reason: 'mtest not found: install TFEL / MFront yourself' } },
    );
    expect(result).toMatchObject({ isError: true, changed: false, error: { code: 'MFRONT_TOOL_MISSING' } });
    expect(result.summary).toContain('install TFEL / MFront yourself');
    const noCompiler = await runMtestTool(
      { mtest: 'x', mfront: { name: 'B', source: 's' } },
      { env: ALLOWED, tools: { mtest: FOUND.mtest, mfront: null, reason: 'mfront not found' }, runner: fakeRunner(() => ok) },
    );
    expect(noCompiler.error?.code).toBe('MFRONT_TOOL_MISSING');
  });

  it('refuses to run native code unless LLULL_ALLOW_CODE_EXECUTION=1', async () => {
    const calls: Call[] = [];
    const result = await runMtestTool({ mtest: 'x' }, { env: {}, tools: FOUND, runner: fakeRunner(() => ok, calls) });
    expect(result.error?.code).toBe('MFRONT_CODE_EXECUTION_DISABLED');
    expect(calls).toHaveLength(0);
  });

  it('refuses bad params without running anything', async () => {
    const deps = { env: ALLOWED, tools: FOUND, runner: fakeRunner(() => ok) };
    expect((await runMtestTool({}, deps)).error?.code).toBe('MTEST_PARAMS_INVALID');
    expect((await runMtestTool('nope', deps)).error?.code).toBe('MTEST_PARAMS_INVALID');
    expect((await runMtestTool({ mtest: 'x', mfront: { name: '../evil', source: 's' } }, deps)).error?.code).toBe('MTEST_PARAMS_INVALID');
    expect((await runMtestTool({ mtest: 'x', mfront: { name: 'B' } }, deps)).error?.code).toBe('MTEST_PARAMS_INVALID');
  });

  it('compiles the behaviour, substitutes {{library}}, runs mtest and returns the table', async () => {
    const calls: Call[] = [];
    const runner = fakeRunner(async (call) => {
      if (call.executable === FOUND.mtest) await writeFile(path.join(call.cwd, 'job.res'), RES);
      return ok;
    }, calls);
    const result = await runMtestTool(
      {
        mtest: "@Behaviour<generic> '{{library}}' 'Norton';",
        mfront: { name: 'Norton', source: '@DSL Implicit;', library: 'Norton' },
        timeoutS: 5,
      },
      { env: ALLOWED, tools: FOUND, runner },
    );
    expect(result.isError).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.data).toMatchObject({ columns: ['Time', 'EXX', 'SXX'], rowCount: 3, truncated: false });
    expect(calls.map((call) => path.basename(call.executable))).toEqual(['mfront', 'mtest']);
    expect(calls[0]?.args).toEqual(['--obuild', '--interface=generic', 'Norton.mfront']);
    expect(calls[0]?.files).toContain('Norton.mfront');
    expect(calls[1]?.args).toEqual(['job.mtest']);
    expect(calls[1]?.script).toMatch(/^@Behaviour<generic> 'src\/libNorton\.(so|dll|dylib)' 'Norton';$/);
    expect(result.summary).toContain('not llull-validated');
  });

  it('maps process failures to coded refusals', async () => {
    const run = (behaviour: (call: Call) => ProcessResult, params: Record<string, unknown> = { mtest: 'x' }): Promise<string | undefined> =>
      runMtestTool(params, { env: ALLOWED, tools: FOUND, runner: fakeRunner(behaviour) }).then((outcome) => outcome.error?.code);
    expect(await run(() => ({ exitCode: 1, log: 'syntax error', timedOut: false }))).toBe('MTEST_FAILED');
    expect(await run(() => ({ exitCode: null, log: '', timedOut: true }))).toBe('MTEST_TIMEOUT');
    expect(await run(() => ({ exitCode: null, log: '', timedOut: false, startError: 'spawn EACCES' }))).toBe('MFRONT_TOOL_MISSING');
    expect(await run(() => ok)).toBe('MTEST_RESULT_MISSING');
    const build = { mtest: 'x', mfront: { name: 'B', source: 's' } };
    expect(await run(() => ({ exitCode: 2, log: 'error: expected ;', timedOut: false }), build)).toBe('MFRONT_BUILD_FAILED');
    expect(await run(() => ({ exitCode: null, log: '', timedOut: true }), build)).toBe('MTEST_TIMEOUT');
    expect(await run(() => ({ exitCode: null, log: '', timedOut: false, startError: 'ENOENT' }), build)).toBe('MFRONT_TOOL_MISSING');
  });

  it('keeps the log tail of a failure in data.log', async () => {
    const outcome = await runMtestTool(
      { mtest: 'x' },
      { env: ALLOWED, tools: FOUND, runner: fakeRunner(() => ({ exitCode: 1, log: 'boom at line 3', timedOut: false })) },
    );
    expect(outcome.data).toMatchObject({ code: 'MTEST_FAILED', log: 'boom at line 3' });
  });

  it('is reachable through runNativeTool and never changes the document', async () => {
    const outcome = await runNativeTool('mtest_run', { probe: true }, { getDoc: () => ({}) as never } as never);
    expect(outcome).toMatchObject({ changed: false, isError: false });
  });
});

describe('a real MTest install (skipped when absent)', () => {
  const tools = mfrontTools();
  if (tools.mtest === null) console.warn(`mtest_run real-run test skipped: ${tools.reason ?? 'mtest not found'}`);
  it.skipIf(tools.mtest === null)('starts the detected mtest and reads its version banner', async () => {
    const result = await spawnRunner.run(tools.mtest ?? '', ['--version'], process.cwd(), 30_000, toolEnvironment());
    expect(result.startError).toBeUndefined();
    expect(result.timedOut).toBe(false);
    expect(result.log.length).toBeGreaterThan(0);
  });
});
