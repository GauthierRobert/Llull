/**
 * Validation scenarios of packs 10 AER and 11 FLD: every plan under docs/aerospace/1{0,1}-*\/validation/plans runs through build_project
 * (the CLI `llull run plan.json` path) and each `expected` row is checked against the step's data.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';

interface Expectation {
  step: number;
  path: string;
  value: number;
  rel?: number;
  abs?: number;
  min?: number;
  maxRel?: number;
  source: string;
}
interface Scenario {
  id: string;
  actions: unknown[];
  expected: Expectation[];
}
interface Report {
  ok: boolean;
  steps: Array<{ ok: boolean; summary: string; data?: unknown }>;
}

const folders = ['10-aerodynamics', '11-fluid-dynamics-propulsion'].map((pack) =>
  resolve(process.cwd(), 'docs/aerospace', pack, 'validation/plans'),
);
const scenarios = folders.flatMap((folder) =>
  readdirSync(folder)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(folder, file), 'utf8')) as Scenario),
);

const at = (value: unknown, path: string): number =>
  path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], value) as number;

describe('validation scenarios SC-AER / SC-FLD (build_project)', () => {
  it('finds the scenario plans', () => expect(scenarios.length).toBeGreaterThanOrEqual(8));

  it.each(scenarios.map((scenario) => [scenario.id, scenario] as const))('%s', (_id, scenario) => {
    const result = execute(createEmptyDocument(), 'build_project', { actions: scenario.actions });
    const report = result.data as Report;
    expect(report.ok, report.steps.map((step) => step.summary).join('\n')).toBe(true);
    for (const row of scenario.expected) {
      const actual = at(report.steps[row.step]?.data, row.path);
      const label = `${scenario.id} step ${row.step} ${row.path} (${row.source})`;
      expect(Number.isFinite(actual), label).toBe(true);
      if (row.min !== undefined) {
        expect(actual, label).toBeGreaterThanOrEqual(row.min);
        expect(actual / row.min - 1, label).toBeLessThanOrEqual(row.maxRel as number);
      } else if (row.abs !== undefined) expect(Math.abs(actual - row.value), label).toBeLessThanOrEqual(row.abs);
      else expect(Math.abs(actual / row.value - 1), label).toBeLessThanOrEqual(row.rel as number);
    }
  });
});
