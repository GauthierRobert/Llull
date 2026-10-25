/**
 * Plant 06 STA: runs the validation pack's scenario plans (`validation/plans/*.json`) through `build_project` (the path of `llull run plan.json`)
 * and compares each `expected` row with the step's `data`. SC-STA-06 (grating span) is complete since M2. SC-STA-05 (negative access) runs in
 * `continue` mode since M3: its `add_ladder` step fails as an unknown command until M4, and the rows that need the ladder are skipped by name.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';

const PLANS = path.resolve(__dirname, '../../../../docs/plant/06-plant-structures-access/validation/plans');

interface Expected {
  step: number;
  path: string;
  value?: unknown;
  abs?: number;
  rel?: number;
}
interface Plan {
  id: string;
  actions: Array<{ command: string; params: Record<string, unknown> }>;
  expected: Expected[];
}
interface Report {
  ok: boolean;
  steps: Array<{ ok: boolean; command: string; summary: string; data?: unknown }>;
}

/** `a.b[k=v][k2=w].c` lookup: adjacent bracket filters all apply to the same array and take its first match; `[2]` indexes. */
function pick(root: unknown, expression: string): unknown {
  const tokens = [...expression.matchAll(/\[([^\]]+)\]|([^.[\]]+)/g)];
  let node: unknown = root;
  for (let index = 0; index < tokens.length; index++) {
    const [, bracket, key] = tokens[index] as RegExpMatchArray;
    if (node === undefined || node === null) return undefined;
    if (key !== undefined) node = (node as Record<string, unknown>)[key];
    else if (bracket !== undefined && Array.isArray(node)) {
      const filters = [bracket];
      while (tokens[index + 1]?.[1] !== undefined) filters.push(tokens[++index]?.[1] as string);
      const parsed = filters.map((filter) => /^(\w+)=(.+)$/.exec(filter));
      node = parsed.every((filter) => filter !== null)
        ? node.find((item) => parsed.every((filter) => String((item as Record<string, unknown>)[filter?.[1] as string]) === filter?.[2]))
        : node[Number(bracket)];
    }
  }
  return node;
}

function compare(actual: unknown, row: Expected): void {
  const label = `${row.path}: ${JSON.stringify(actual)} vs ${JSON.stringify(row.value)}`;
  if (typeof row.value === 'number') {
    const tolerance = row.abs ?? Math.abs(row.value) * (row.rel ?? 0);
    expect(typeof actual, label).toBe('number');
    expect(Math.abs((actual as number) - row.value), label).toBeLessThanOrEqual(tolerance);
  } else if (row.value === 'absent') expect(actual, label).toBeUndefined();
  else expect(actual, label).toEqual(row.value);
}

function run(file: string): { plan: Plan; report: Report } {
  const plan = JSON.parse(readFileSync(path.join(PLANS, file), 'utf8')) as Plan;
  const result = execute(createEmptyDocument(), 'build_project', { actions: plan.actions, onError: 'continue' });
  return { plan, report: result.data as Report };
}

/** Rows that wait for a later milestone (ladder), describe a relation instead of a value, or are checked by name below. */
const waits = (row: Expected): boolean =>
  /LADDER/.test(row.path) || (typeof row.value === 'string' && /^(contains|non-empty)/.test(row.value));

describe('SC-STA-06 grating span (VC-STA-06)', () => {
  const { plan, report } = run('sc-sta-06-grating-span.json');

  it('runs every step without a failure', () => {
    expect(report.steps.map((step) => step.summary).filter((_, index) => !report.steps[index]?.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('meets every expected row (closed form against the two manufacturer tables)', () => {
    expect(plan.expected.length).toBeGreaterThanOrEqual(5);
    for (const row of plan.expected) compare(pick(report.steps[row.step], row.path), row);
  });

  it('is deterministic: a second run gives byte-identical step data (AF-13)', () => {
    expect(JSON.stringify(run('sc-sta-06-grating-span.json').report.steps)).toBe(JSON.stringify(report.steps));
  });
});

describe('SC-STA-05 negative access (VC-STA-05, VC-STA-13), railing and edge rows', () => {
  const { plan, report } = run('sc-sta-05-access-negative.json');
  const ladderStep = plan.actions.findIndex((action) => action.command === 'add_ladder');

  it('runs every registered step; only add_ladder (M4) fails', () => {
    expect(report.steps.filter((step) => !step.ok).map((step) => step.command)).toEqual(['add_ladder']);
    expect(report.steps[ladderStep]?.ok).toBe(false);
  });

  it('meets the railing, edge and review rows', () => {
    const rows = plan.expected.filter((row) => !waits(row));
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const row of rows) compare(pick(report.steps[row.step], row.path), row);
  });

  it('gives a remediation for every finding and lists the deck among the unprotected edges', () => {
    const checked = report.steps[plan.actions.length - 1]?.data as {
      findings: Array<{ remediation: string; code: string; ids: string[] }>;
    };
    expect(checked.findings.every((finding) => finding.remediation.length > 0)).toBe(true);
    expect(
      checked.findings.filter((finding) => finding.code === 'STA_EDGE_UNPROTECTED').every((finding) => finding.ids[0] === 'slab-1'),
    ).toBe(true);
  });
});
