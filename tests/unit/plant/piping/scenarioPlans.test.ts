/**
 * Plant 01 PSC: runs the validation pack's scenario plans (`validation/plans/*.json`) step by step through `execute` (the path of
 * `llull run plan.json`) and compares each `expected` row with the step's `data` / `error`. Steps whose command is not registered yet
 * (M2+: specs, wall check) are skipped; their `unbuilt` entry says so.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute, getCommand } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

const PLANS = path.resolve(__dirname, '../../../../docs/plant/01-piping-specs-catalog/validation/plans');

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

/** `a.b[0].c` and `issues[code=X].ids` lookups. */
function pick(root: unknown, expression: string): unknown {
  return expression.split('.').reduce<unknown>((node, part) => {
    const match = /^([^[]*)(?:\[(.+)\])?$/.exec(part);
    const key = match?.[1] ?? part;
    let value = key === '' ? node : (node as Record<string, unknown> | undefined)?.[key];
    const index = match?.[2];
    if (index !== undefined && Array.isArray(value)) {
      const filter = /^(\w+)=(.+)$/.exec(index);
      value = filter ? value.find((item: Record<string, unknown>) => item[filter[1] as string] === filter[2]) : value[Number(index)];
    }
    return value;
  }, root);
}

function runPlan(name: string): { plan: Plan; outcomes: Array<Record<string, unknown> | null> } {
  const plan = JSON.parse(readFileSync(path.join(PLANS, name), 'utf8')) as Plan;
  let doc: CadDocument = createEmptyDocument();
  const outcomes = plan.actions.map((action) => {
    if (getCommand(action.command) === undefined) return null;
    const result = execute(doc, action.command, action.params);
    doc = result.document;
    return { ...(result.data as Record<string, unknown> | undefined), error: result.error } as Record<string, unknown>;
  });
  return { plan, outcomes };
}

function compare(actual: unknown, row: Expected): void {
  if (typeof row.value === 'number' && typeof actual === 'number') {
    const tolerance = row.abs ?? (row.rel === undefined ? 0 : Math.abs(row.value) * row.rel);
    expect(Math.abs(actual - row.value), `${row.path}: ${actual} vs ${row.value}`).toBeLessThanOrEqual(tolerance);
  } else if (row.value === null) expect(actual ?? null).toBeNull();
  else expect(actual, row.path).toEqual(row.value);
}

describe.each(['sc-psc-01-catalog-lookup-mass.json', 'sc-psc-03-design-conditions.json', 'sc-psc-05-catalog-import-checks.json'])(
  'scenario plan %s',
  (file) => {
    const { plan, outcomes } = runPlan(file);

    it('runs every registered step and meets the expected rows of those steps', () => {
      const built = plan.expected.filter((row) => outcomes[row.step] !== null && typeof row.value !== 'undefined');
      expect(built.length).toBeGreaterThan(0);
      for (const row of built) {
        if (typeof row.value === 'string' && row.value.startsWith('equal to')) continue;
        compare(pick(outcomes[row.step], row.path), row);
      }
    });
  },
);
