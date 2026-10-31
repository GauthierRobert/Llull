/** Plant 04 PID M7: SC-PID-03 (P&ID vs 3D, four seeded inconsistencies) run step by step through `execute`, every `expected` row compared. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { PID_PACK } from './dexpiFixtures';

interface Plan {
  actions: Array<{ command: string; params: Record<string, unknown>; as?: string }>;
  expected: Array<{ step: number; path: string; value: unknown }>;
  cleanVariant: string;
}

const plan = JSON.parse(readFileSync(path.join(PID_PACK, 'plans', 'sc-pid-03-pid-vs-3d.json'), 'utf8')) as Plan;

function run(actions: Plan['actions']): { results: CommandResult[]; doc: CadDocument } {
  let doc = createEmptyDocument();
  const bindings = new Map<string, string>();
  const resolve = (value: unknown): unknown => {
    if (typeof value === 'string') return value.startsWith('$') ? (bindings.get(value.slice(1)) ?? value) : value;
    if (Array.isArray(value)) return value.map(resolve);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
    return value;
  };
  const results = actions.map((action) => {
    const result = execute(doc, action.command, resolve(action.params));
    doc = result.document;
    const first = result.affected[0];
    if (action.as !== undefined && first !== undefined) bindings.set(action.as, first);
    return result;
  });
  return { results, doc };
}

const dig = (root: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], root);

describe('SC-PID-03: P&ID vs 3D', () => {
  const { results } = run(plan.actions);

  it('runs all 11 steps without a refusal', () => {
    expect(plan.actions).toHaveLength(11);
    expect(plan.actions.at(-1)?.command).toBe('check_pid_3d');
    for (const result of results) expect(result.rejected, result.summary).toBeUndefined();
  });

  it('meets every expected row: one UNPLACED, NOT_IN_PID, SIZE and CONNECTIVITY mismatch, tag and line-number matches, no safety verdict', () => {
    expect(plan.expected).toHaveLength(7);
    for (const row of plan.expected)
      expect(dig({ data: results[row.step]?.data }, row.path), `step ${row.step} ${row.path}`).toEqual(row.value);
  });

  it('reports exactly the four seeded findings and nothing else', () => {
    const items = (results[10]?.data as { items: Array<{ code: string; item: string }> }).items;
    expect(items.map((f) => [f.code, f.item])).toEqual([
      ['P3D_UNPLACED', 'HV-104'],
      ['P3D_NOT_IN_PID', 'E-201'],
      ['P3D_SIZE_MISMATCH', '100-P-1001-A1'],
      ['P3D_CONNECTIVITY_MISMATCH', '100-P-1001-A1'],
    ]);
    expect((results[10]?.data as { status: string }).status).toBe('fail');
  });

  it('clean variant: DN 100, from T-101, no extra equipment leaves only P3D_UNPLACED for HV-104', () => {
    const actions = plan.actions.filter((a) => a.params['mark'] !== 'E-201').map((a) => ({ ...a, params: { ...a.params } }));
    const pipe = actions.find((a) => a.command === 'add_pipe_run');
    if (pipe === undefined) throw new Error('plan has no add_pipe_run');
    pipe.params['dn'] = 100;
    pipe.params['from'] = 'T-101';
    const items = (run(actions).results.at(-1)?.data as { items: Array<{ code: string; item: string }> }).items;
    expect(items.map((f) => [f.code, f.item])).toEqual([['P3D_UNPLACED', 'HV-104']]);
  });
});
