/**
 * @layer server/tests
 * `llull run` progress (`--progress` / TTY), per-step timing (`durationMs`), the slow-step warning
 * and the `--timeout` deadline, driven by a fake clock through `runCli`.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { EXIT_COMMAND_ERROR, EXIT_OK, EXIT_USAGE, runCli, type CliIo } from '../src/cli/main';
import { formatDuration } from '../src/cli/progress';

interface Captured {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

/** A clock that advances `tick` ms on every read: every step then takes exactly `tick` ms. */
function capture(options: { stdin: string; tick?: number; tty?: boolean; fetchImpl?: CliIo['fetchImpl'] }): Captured {
  const out: string[] = [];
  const err: string[] = [];
  let clock = 0;
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(options.stdin),
    env: {},
    prepareKernel: () => Promise.resolve(),
    now: () => (clock += options.tick ?? 0),
    ...(options.tty === true ? { stderrIsTty: true } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  };
  return { io, out, err };
}

const PLAN = JSON.stringify([
  { command: 'add_box', params: { size: [20, 20, 20] }, as: 'body' },
  { command: 'add_cylinder', params: { radius: 4, height: 30 }, as: 'hole' },
  { command: 'boolean', params: { op: 'subtract', a: '$body', b: '$hole' } },
]);

let docPath = '';
const docFlag = (): string[] => ['--doc', docPath];

beforeAll(async () => {
  setGeometryKernel(await createManifoldKernel());
});

beforeEach(() => {
  docPath = path.join(mkdtempSync(path.join(tmpdir(), 'llull-progress-')), 'part.llull.json');
});

describe('llull run — progress and timing', () => {
  it('streams one stderr line per step with --progress, announcing kernel commands first', async () => {
    const c = capture({ stdin: PLAN, tick: 1500 });
    expect(await runCli(['run', '-', '--progress', ...docFlag()], c.io)).toBe(EXIT_OK);
    expect(c.err).toEqual(['[1/3] add_box … 1.5s', '[2/3] add_cylinder … 1.5s', '[3/3] boolean …', '[3/3] boolean … 1.5s']);
  });

  it('streams progress when stderr is a terminal, and stays silent when it is not', async () => {
    const tty = capture({ stdin: PLAN, tick: 100, tty: true });
    await runCli(['run', '-', ...docFlag()], tty.io);
    expect(tty.err).toHaveLength(4);

    const piped = capture({ stdin: PLAN, tick: 100 });
    await runCli(['run', '-', '--dry-run', ...docFlag()], piped.io);
    expect(piped.err).toEqual([]);
  });

  it('marks a failed step and keeps going with --continue', async () => {
    const c = capture({
      stdin: JSON.stringify([
        { command: 'add_box', params: {} },
        { command: 'add_sphere', params: { radius: 1 } },
      ]),
      tick: 10,
    });
    expect(await runCli(['run', '-', '--progress', '--continue', ...docFlag()], c.io)).toBe(EXIT_COMMAND_ERROR);
    expect(c.err).toEqual(['[1/2] add_box … 0.0s FAILED', '[2/2] add_sphere … 0.0s']);
  });

  it('warns about steps slower than 10 s even without --progress', async () => {
    const c = capture({ stdin: PLAN, tick: 12_000 });
    await runCli(['run', '-', ...docFlag()], c.io);
    expect(c.err).toHaveLength(3);
    expect(c.err[2]).toBe('llull: warning: slow step [3/3] boolean took 12.0s');
  });

  it('adds durationMs to every step in --json and shows slow steps in text mode', async () => {
    const json = capture({ stdin: PLAN, tick: 2500 });
    await runCli(['run', '-', '--json', '--dry-run', ...docFlag()], json.io);
    const report = JSON.parse(json.out[0] ?? '') as { data: { steps: { durationMs: number }[] } };
    expect(report.data.steps.map((step) => step.durationMs)).toEqual([2500, 2500, 2500]);

    const text = capture({ stdin: PLAN, tick: 2500 });
    await runCli(['run', '-', '--dry-run', ...docFlag()], text.io);
    expect(text.out[0]).toMatch(/#2 ok {3}boolean \[2\.5s\]:/);
  });

  it('says --progress does nothing with --server', async () => {
    const c = capture({
      stdin: PLAN,
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ summary: 'ok', affected: [], changed: true }))),
    });
    await runCli(['run', '-', '--progress', '--server', 'http://cad.local:3001'], c.io);
    expect(c.err[0]).toMatch(/--progress has no effect with --server/);
  });
});

describe('llull run — --timeout', () => {
  it('stops before the next step once the deadline passed: exit 1, clear message, nothing saved', async () => {
    const c = capture({ stdin: PLAN, tick: 1500 });
    expect(await runCli(['run', '-', '--timeout', '2', ...docFlag()], c.io)).toBe(EXIT_COMMAND_ERROR);
    expect(c.out.join('\n')).toBe('llull: timed out after 2s (--timeout) before step 2/3 (add_cylinder); stopped, nothing was saved.');
    expect(existsSync(docPath)).toBe(false);
  });

  it('lets a run that finishes in time complete', async () => {
    const c = capture({ stdin: PLAN, tick: 1 });
    expect(await runCli(['run', '-', '--timeout=60', ...docFlag()], c.io)).toBe(EXIT_OK);
    expect(existsSync(docPath)).toBe(true);
  });

  it('rejects a non-positive or non-numeric value (exit 2)', async () => {
    for (const value of ['0', '-3', 'soon']) {
      const c = capture({ stdin: PLAN });
      expect(await runCli(['run', '-', '--timeout', value, ...docFlag()], c.io)).toBe(EXIT_USAGE);
      expect(c.err[0]).toMatch(/--timeout needs a positive number of seconds/);
    }
    const missing = capture({ stdin: PLAN });
    expect(await runCli(['run', '-', '--timeout'], missing.io)).toBe(EXIT_USAGE);
  });

  it('applies to --server calls as a request timeout', async () => {
    const c = capture({
      stdin: PLAN,
      fetchImpl: () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
    });
    expect(await runCli(['run', '-', '--timeout', '5', '--server', 'http://cad.local:3001'], c.io)).toBe(EXIT_COMMAND_ERROR);
    expect(c.out[0]).toMatch(/Timed out after 5s waiting for the llull server .*\(--timeout\)/);
  });
});

describe('formatDuration', () => {
  it('prints seconds below a minute and minutes beyond', () => {
    expect(formatDuration(3200)).toBe('3.2s');
    expect(formatDuration(65_000)).toBe('1m05s');
    expect(formatDuration(600_000)).toBe('10m00s');
  });
});

describe('llull --timeout supervisor (real launcher)', () => {
  const launcher = path.resolve(__dirname, '..', 'bin', 'llull.cjs');
  const run = (args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ stdout: string; stderr: string; code: number }> =>
    promisify(execFile)(process.execPath, [launcher, ...args], { env }).then(
      ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
      (error: { stdout: string; stderr: string; code: number }) => error,
    );

  it('runs the command in a supervised child and passes its result and exit code through', async () => {
    const ok = await run(['add_box', 'size=[2,2,2]', '--timeout', '60', '--doc', docPath]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/Added box/);
    expect(existsSync(docPath)).toBe(true);

    const failed = await run(['add_box', 'size=[0,0,0]', '--timeout', '60', '--doc', docPath]);
    expect(failed.code).toBe(1);
  }, 120_000);

  it('kills a child that never finishes (blocked on stdin) and exits 1 with the timeout message', async () => {
    const stuck = await run(['run', '-', '--timeout', '1', '--doc', docPath], {
      ...process.env,
      LLULL_CLI_KILL_GRACE_SECONDS: '0',
    });
    expect(stuck.code).toBe(1);
    expect(stuck.stderr).toMatch(/llull: timed out after 1s \(--timeout\); the run was killed/);
  }, 120_000);
});
