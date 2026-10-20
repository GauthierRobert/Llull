/** `llull fuzz` and `llull fuzz-one` (SC-Q3) through `runCli` on the in-process Manifold kernel: reports, plans, jobs, minimising. */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { EXIT_OK, EXIT_USAGE, runCli, type CliIo } from '../src/cli/main';
import { parseArgv } from '../src/cli/argv';
import { fuzzCli, type FuzzReportFile } from '../src/cli/fuzz';

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      readStdin: () => Promise.resolve(''),
      env: {},
      prepareKernel: () => Promise.resolve(),
    },
    out,
    err,
  };
}

let dir = '';

beforeAll(async () => {
  setGeometryKernel(await createManifoldKernel());
}, 60_000);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-fuzz-'));
});

describe('llull fuzz', () => {
  it('runs a seed range, prints one line per seed and writes the JSON report', async () => {
    const c = capture();
    const report = path.join(dir, 'out', 'report.json');
    const code = await runCli(['fuzz', '--from', '1', '--count', '4', '--out', path.join(dir, 'fails'), '--report', report], c.io);
    expect(code).toBe(EXIT_OK);
    expect(c.out.slice(0, 4).map((line) => line.split(':')[0])).toEqual(['seed 1', 'seed 2', 'seed 3', 'seed 4']);
    expect(c.out.at(-1)).toMatch(/^fuzz: 4\/4 seeds passed on the manifold kernel \(kinds: join, cut, hole, pattern\)/);
    const file = JSON.parse(readFileSync(report, 'utf8')) as FuzzReportFile;
    expect(file).toMatchObject({ kernel: 'manifold', from: 1, count: 4, summary: { seeds: 4, passed: 4, failed: 0 }, failures: [] });
    expect(file.seeds.map((s) => s.seed)).toEqual([1, 2, 3, 4]);
    expect(existsSync(path.join(dir, 'fails'))).toBe(false);
  }, 60_000);

  it('prints the report as JSON with --json and honours --kinds / --max-steps', async () => {
    const c = capture();
    expect(await runCli(['fuzz', '--from', '7', '--count', '2', '--kinds', 'cut,hole', '--max-steps', '2', '--json'], c.io)).toBe(EXIT_OK);
    const file = JSON.parse(c.out.join('')) as FuzzReportFile;
    expect(file.kinds).toEqual(['cut', 'hole']);
    expect(file.seeds.every((s) => s.steps <= 3)).toBe(true);
  }, 60_000);

  it('splits the range over --jobs workers and merges their reports', async () => {
    const workers: string[][] = [];
    const c = capture();
    const runWorker = async (args: readonly string[]): Promise<number> => {
      workers.push([...args]);
      return runCli(args, capture().io);
    };
    const code = await fuzzCli(parseArgv(['fuzz', '--from', '10', '--count', '5', '--jobs', '2', '--report', path.join(dir, 'r.json')]), {
      ...c.io,
      runWorker,
    });
    expect(code).toBe(EXIT_OK);
    expect(workers.map((args) => [args[2], args[4]])).toEqual([
      ['10', '3'],
      ['13', '2'],
    ]);
    const file = JSON.parse(readFileSync(path.join(dir, 'r.json'), 'utf8')) as FuzzReportFile;
    expect(file.seeds.map((s) => s.seed)).toEqual([10, 11, 12, 13, 14]);
    expect(file.summary).toMatchObject({ seeds: 5, passed: 5, failed: 0 });
  }, 60_000);

  it('rejects bad numbers and unknown kinds as usage errors', async () => {
    for (const argv of [
      ['fuzz', '--count', '0'],
      ['fuzz', '--from', 'x'],
      ['fuzz', '--kinds', 'weld'],
    ]) {
      const c = capture();
      expect(await runCli(argv, c.io)).toBe(EXIT_USAGE);
      expect(c.err.join('')).toMatch(/^llull: (--count|--from|unknown --kinds)/);
    }
  });
});

describe('llull fuzz-one', () => {
  it('prints the steps of one seed with their volumes', async () => {
    const c = capture();
    expect(await runCli(['fuzz-one', '5'], c.io)).toBe(EXIT_OK);
    const text = c.out.join('\n');
    expect(text).toMatch(/^seed 5: ok/);
    expect(text).toMatch(/\[0\] base {4}ok {3}(box|extrude|revolve) .*V=\d+\.\d{3}/);
    expect(text).toMatch(/identity: ok A = /);
  }, 60_000);

  it('--minimise on a passing seed says so and --out writes the replayable plan', async () => {
    const c = capture();
    const plan = path.join(dir, 'seed-5.plan.json');
    expect(await runCli(['fuzz-one', '5', '--minimise', '--out', plan], c.io)).toBe(EXIT_OK);
    expect(c.out.join('\n')).toMatch(/nothing to minimise: the design passes\./);
    const written = JSON.parse(readFileSync(plan, 'utf8')) as { actions: { command: string }[] };
    expect(written.actions[0]).toEqual({ command: 'set_units', params: { units: 'mm' } });
    const replay = capture();
    expect(await runCli(['run', plan, '--doc', path.join(dir, 'replay.llull.json'), '--no-fit'], replay.io)).toBe(EXIT_OK);
  }, 60_000);

  it('accepts the seed after --minimise and returns JSON with --json', async () => {
    const c = capture();
    expect(await runCli(['fuzz-one', '--minimise', '6', '--json'], c.io)).toBe(EXIT_OK);
    const parsed = JSON.parse(c.out.join('')) as { report: { seed: number; ok: boolean }; plan: { actions: unknown[] } };
    expect(parsed.report).toMatchObject({ seed: 6, ok: true });
    expect(parsed.plan.actions.length).toBeGreaterThan(2);
    expect(readdirSync(dir)).toEqual([]);
  }, 60_000);

  it('needs a seed', async () => {
    const c = capture();
    expect(await runCli(['fuzz-one'], c.io)).toBe(EXIT_USAGE);
    expect(c.err.join('')).toMatch(/fuzz-one needs a seed/);
  });
});
