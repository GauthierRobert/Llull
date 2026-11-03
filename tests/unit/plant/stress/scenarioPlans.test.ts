/**
 * Plant 07 PST: runs the validation pack's scenario plans through `build_project` (the path of `llull run plan.json`) and compares each `expected`
 * row with the step's `data`. SC-PST-03 (quick checks) is complete since M1; SC-PST-01, 02 and 04 (L-bend, PSI 3D, supports and guardrails) since M3; SC-PST-05 waits for M5
 * (tests/unit/contract/blockedPlanCommands.json).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { TOOLSETS } from '@protocol/toolsets';

const PLANS = path.resolve(__dirname, '../../../../docs/plant/07-pipe-stress-flexibility/validation/plans');

interface Expected {
  step: number;
  path: string;
  value: number;
  abs?: number;
  rel?: number;
}
interface Plan {
  actions: Array<{ command: string; params: Record<string, unknown> }>;
  expected: Expected[];
}
interface Report {
  ok: boolean;
  steps: Array<{ ok: boolean; command: string; summary: string; data?: Record<string, unknown> }>;
}

function run(file: string): { plan: Plan; report: Report } {
  const plan = JSON.parse(readFileSync(path.join(PLANS, file), 'utf8')) as Plan;
  const result = execute(createEmptyDocument(), 'build_project', { actions: plan.actions, onError: 'continue' });
  return { plan, report: result.data as Report };
}

describe('SC-PST-03 quick checks (VC-PST-01, 03, 04, 05, 06)', () => {
  const { plan, report } = run('sc-pst-03-quick-checks.json');

  it('runs every step without a failure', () => {
    expect(report.steps.filter((step) => !step.ok).map((step) => step.summary)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('meets every expected row at its stated tolerance', () => {
    expect(plan.expected.length).toBe(15);
    for (const row of plan.expected) {
      const actual = report.steps[row.step]?.data?.[row.path];
      const label = `step ${row.step} ${row.path}: ${String(actual)} vs ${row.value}`;
      expect(typeof actual, label).toBe('number');
      expect(Math.abs((actual as number) - row.value), label).toBeLessThanOrEqual(row.abs ?? Math.abs(row.value) * (row.rel ?? 0));
    }
  });

  it('is deterministic: a second run gives byte-identical step data (AF-13)', () => {
    expect(JSON.stringify(run('sc-pst-03-quick-checks.json').report.steps)).toBe(JSON.stringify(report.steps));
  });
});

describe('SC-PST-05 step 0 (VC-PST-13 occasional arithmetic; the V1 steps wait for M5)', () => {
  it('meets the occasional ratio and names the rule grade', () => {
    const plan = JSON.parse(readFileSync(path.join(PLANS, 'sc-pst-05-springs-nozzles-export.json'), 'utf8')) as Plan & {
      expected: Array<Expected & { value: unknown }>;
    };
    const first = plan.actions[0] as Plan['actions'][number];
    const data = execute(createEmptyDocument(), first.command, first.params).data as Record<string, unknown>;
    const rows = plan.expected.filter((row) => row.step === 0);
    expect(rows).toHaveLength(2);
    expect(Math.abs((data['occasionalRatio'] as number) - 0.76333)).toBeLessThanOrEqual(0.76333 * 1e-5);
    expect(data['occasionalRuleGrade']).toBe(rows[1]?.value);
  });
});

describe('toolset pipestress', () => {
  it('lists the four M1 quick checks and the M3 model, analysis, record and approval commands and the M4 report', () => {
    expect([...TOOLSETS.pipestress].sort()).toEqual([
      'add_stress_restraint',
      'analyze_pipe_stress',
      'approve_pipe_stress',
      'check_pipe_stress',
      'create_stress_model',
      'delete_stress_model',
      'delete_stress_restraint',
      'guided_cantilever',
      'pipe_sif',
      'pipe_stress_allowables',
      'pipe_stress_report',
      'record_pipe_stress_results',
      'set_pipe_operating_conditions',
      'set_stress_load_cases',
      'thermal_growth',
      'update_stress_model',
    ]);
  });
});

/** `name[k=v,k2=v2]` picks the array element whose fields match; a number indexes an array; a missing step in the path is "absent". */
function resolvePath(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const part of path.split('.')) {
    const match = /^([^[]*)(?:\[(.+)\])?$/.exec(part);
    const name = match?.[1] ?? part;
    if (name !== '') {
      node = Array.isArray(node) ? node[Number(name)] : (node as Record<string, unknown> | undefined)?.[name];
    }
    if (match?.[2] !== undefined) {
      const wanted = match[2].split(',').map((pair) => pair.split('=') as [string, string]);
      node = Array.isArray(node)
        ? node.find((item) => wanted.every(([key, value]) => String((item as Record<string, unknown>)[key]) === value))
        : undefined;
    }
    if (node === undefined) return 'absent';
  }
  return node;
}

interface ScenarioPlan extends Plan {
  expected: Array<Expected & { value: unknown }>;
  refusals?: Array<{ step: number; code: string }>;
}

describe.each(['sc-pst-01-lbend-two-anchors.json', 'sc-pst-02-psi-3d-benchmark.json', 'sc-pst-04-supports-guardrails.json'])(
  '%s',
  (file) => {
    const plan = JSON.parse(readFileSync(path.join(PLANS, file), 'utf8')) as ScenarioPlan;
    const report = (execute(createEmptyDocument(), 'build_project', { actions: plan.actions, onError: 'continue' }).data as Report).steps;
    const refused = new Set((plan.refusals ?? []).map((row) => row.step));

    it('runs every step except the declared refusals, which carry their stable code', () => {
      expect(report.filter((step, index) => !step.ok && !refused.has(index)).map((step) => step.summary)).toEqual([]);
      for (const row of plan.refusals ?? []) {
        expect(report[row.step]?.ok).toBe(false);
        expect(report[row.step]?.summary).toContain(row.code);
      }
    });

    it('meets every expected row at its stated tolerance', () => {
      expect(plan.expected.length).toBeGreaterThan(3);
      for (const row of plan.expected) {
        const actual = resolvePath(report[row.step], row.path);
        const label = `step ${row.step} ${row.path}: ${String(actual)} vs ${String(row.value)}`;
        if (typeof row.value === 'number') {
          expect(typeof actual, label).toBe('number');
          expect(Math.abs((actual as number) - row.value), label).toBeLessThanOrEqual(row.abs ?? Math.abs(row.value) * (row.rel ?? 0));
        } else expect(actual, label).toBe(row.value);
      }
    });

    it('is deterministic: a second run gives byte-identical step data (AF-13)', () => {
      const again = (execute(createEmptyDocument(), 'build_project', { actions: plan.actions, onError: 'continue' }).data as Report).steps;
      expect(JSON.stringify(again)).toBe(JSON.stringify(report));
    });
  },
);
