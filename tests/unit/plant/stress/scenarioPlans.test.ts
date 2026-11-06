/**
 * Plant 07 PST: runs the validation pack's scenario plans through `build_project` (the path of `llull run plan.json`) and compares each `expected`
 * row with the step's `data`. SC-PST-03 (quick checks) is complete since M1; SC-PST-01, 02 and 04 (L-bend, PSI 3D, supports and guardrails) since M3; SC-PST-05 runs up to the .cii export since M5b
 * (tests/unit/contract/blockedPlanCommands.json lists export_caesar_neutral).
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

describe('SC-PST-05 steps 0 to 5 (VC-PST-13 occasional arithmetic, VC-PST-14 springs, VC-PST-15 nozzles; step 6 .cii export is not built)', () => {
  const plan = JSON.parse(readFileSync(path.join(PLANS, 'sc-pst-05-springs-nozzles-export.json'), 'utf8')) as Plan & {
    expected: Array<Expected & { value: unknown }>;
  };
  const results = plan.actions.slice(0, 6).map((action) => execute(createEmptyDocument(), action.command, action.params));

  /** The value of a plan path in a step: `error.code`, a data field, or `components[name=X].ratio` (looked up in the refusal detail when the step is refused). */
  const valueOf = (step: number, expectedPath: string): unknown => {
    const result = results[step] as ReturnType<typeof execute>;
    if (expectedPath === 'error.code') return result.error?.code;
    const source = (result.data ?? result.error?.detail) as Record<string, unknown>;
    const component = /^components\[name=(\w+)\]\.(\w+)$/.exec(expectedPath);
    if (component === null) return source[expectedPath];
    const rows = source['components'] as Array<Record<string, unknown>>;
    return rows.find((row) => row['name'] === component[1])?.[component[2] as string];
  };

  it('meets every expected row of steps 0 to 5 at its stated tolerance', () => {
    const rows = plan.expected.filter((row) => row.step <= 5);
    expect(rows).toHaveLength(11);
    for (const row of rows) {
      const actual = valueOf(row.step, row.path);
      const label = `step ${row.step} ${row.path}: ${String(actual)} vs ${String(row.value)}`;
      if (typeof row.value === 'number') {
        expect(typeof actual, label).toBe('number');
        expect(Math.abs((actual as number) - row.value), label).toBeLessThanOrEqual(row.abs ?? Math.abs(row.value) * (row.rel ?? 0));
      } else expect(actual, label).toEqual(row.value);
    }
  });
});

describe('toolset pipestress', () => {
  it('lists the quick checks, the model, analysis, record and approval commands, the report, the M5a component commands and the M5b spring and nozzle commands', () => {
    expect([...TOOLSETS.pipestress].sort()).toEqual([
      'add_stress_restraint',
      'analyze_pipe_stress',
      'approve_pipe_stress',
      'check_pipe_stress',
      'create_stress_model',
      'delete_sif_override',
      'delete_spring_hanger',
      'delete_stress_component',
      'delete_stress_model',
      'delete_stress_restraint',
      'guided_cantilever',
      'import_pipe_material_data',
      'import_spring_table',
      'nozzle_load_check',
      'pipe_sif',
      'pipe_stress_allowables',
      'pipe_stress_report',
      'record_pipe_stress_results',
      'select_spring_hangers',
      'set_pipe_operating_conditions',
      'set_sif_override',
      'set_stress_component',
      'set_stress_load_cases',
      'spring_variability',
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

describe.each([
  'sc-pst-01-lbend-two-anchors.json',
  'sc-pst-02-psi-3d-benchmark.json',
  'sc-pst-04-supports-guardrails.json',
  'sc-pst-06-tee-components-loads.json',
])('%s', (file) => {
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
});
