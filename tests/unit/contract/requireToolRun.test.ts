/** TR-INT-13 end to end: a real vitest run (minimal config) whose only suite skips through requireTool exits 1 or 0 depending on LLULL_REQUIRE_TOOLS. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { skipRoot } from '../../requireTool';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const config = join(root, 'tests', 'fixtures', 'requireTool', 'vitest.config.mts');

function runFixture(required: string | undefined): { status: number | null; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, LLULL_TEST_WORKERS: '1' };
  delete env['LLULL_REQUIRE_TOOLS'];
  delete env['LLULL_TEST_SKIPS_RUN'];
  if (required !== undefined) env['LLULL_REQUIRE_TOOLS'] = required;
  const run = spawnSync(process.execPath, [vitest, 'run', '--config', config], { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe('LLULL_REQUIRE_TOOLS in a real run (TR-INT-13)', () => {
  it('passes and prints the counts when the skipped tool is not required', () => {
    const run = runFixture(undefined);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('skipped by tool: calculix 0, python 1');
  });

  it('exits 1 with TST_REQUIRED_TOOL_SKIPPED when the family or the exact id is required', () => {
    for (const required of ['python', 'python:ocp']) {
      const run = runFixture(required);
      expect(run.status, required).toBe(1);
      expect(run.output, required).toContain('TST_REQUIRED_TOOL_SKIPPED');
    }
  });

  it('does not fail for an exact id that was not skipped', () => {
    expect(runFixture('python:pynastran').status).toBe(0);
  });

  it('exits 1 with TST_REQUIRE_TOOLS_UNKNOWN for a name that is no tool (typo, wrong case)', () => {
    for (const required of ['Python', 'pyhton']) {
      const run = runFixture(required);
      expect(run.status, required).toBe(1);
      expect(run.output, required).toContain('TST_REQUIRE_TOOLS_UNKNOWN');
    }
  });

  it('prunes run directories older than 24 hours and keeps recent ones', () => {
    const old = join(skipRoot(), 'prune-test-old');
    const recent = join(skipRoot(), 'prune-test-recent');
    mkdirSync(old, { recursive: true });
    mkdirSync(recent, { recursive: true });
    const stale = new Date(Date.now() - 25 * 3600 * 1000);
    utimesSync(old, stale, stale);
    try {
      expect(runFixture(undefined).status).toBe(0);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(recent)).toBe(true);
    } finally {
      rmSync(old, { recursive: true, force: true });
      rmSync(recent, { recursive: true, force: true });
    }
  });
});
