/**
 * Plant 03 EQP: runs the validation pack's scenario plans (`validation/plans/*.json`) step by step through `execute` (the path of
 * `llull run plan.json`) and compares each `expected` row with the step's `data` / `error`. Steps whose command is not registered yet
 * (M3 code checks, data sheet; M4 exchanger, tank) are skipped, and so are their rows. SC-EQP-03 / 04 start with M4 commands and are not run.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute, getCommand } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

const PLANS = path.resolve(__dirname, '../../../../docs/plant/03-parametric-equipment/validation/plans');

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

/** `a.b[0].c`, `levels.0.x` and `issues[code=X].ids` lookups. */
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

function runPlan(name: string): { plan: Plan; outcomes: Array<Record<string, unknown> | null>; final: CadDocument } {
  const plan = JSON.parse(readFileSync(path.join(PLANS, name), 'utf8')) as Plan;
  let doc: CadDocument = createEmptyDocument();
  const outcomes = plan.actions.map((action) => {
    if (getCommand(action.command) === undefined) return null;
    const result = execute(doc, action.command, action.params);
    expect(result.rejected, `${action.command}: ${result.summary}`).toBeUndefined();
    doc = result.document;
    return { ...(result.data as Record<string, unknown> | undefined), error: result.error } as Record<string, unknown>;
  });
  return { plan, outcomes, final: doc };
}

function compare(actual: unknown, row: Expected): void {
  const tolerance = (value: number): number => row.abs ?? (row.rel === undefined ? 0 : Math.abs(value) * row.rel);
  if (typeof row.value === 'number' && typeof actual === 'number') {
    expect(Math.abs(actual - row.value), `${row.path}: ${actual} vs ${row.value}`).toBeLessThanOrEqual(tolerance(row.value));
  } else if (Array.isArray(row.value) && Array.isArray(actual)) {
    expect(actual, row.path).toHaveLength(row.value.length);
    row.value.forEach((value: number, index: number) =>
      expect(Math.abs((actual[index] as number) - value), `${row.path}[${index}]`).toBeLessThanOrEqual(tolerance(value)),
    );
  } else expect(actual, row.path).toEqual(row.value);
}

describe.each(['sc-eqp-01-vertical-vessel-skirt.json', 'sc-eqp-02-horizontal-drum-saddles.json'])('scenario plan %s (M2 steps)', (file) => {
  const { plan, outcomes } = runPlan(file);

  it('runs every registered step without a refusal and meets the expected rows of those steps (VC-EQP-12, 13, 14 geometry rows)', () => {
    const built = plan.expected.filter((row) => outcomes[row.step] != null && typeof row.value !== 'undefined');
    expect(built.length).toBeGreaterThanOrEqual(5);
    for (const row of built) compare(pick(outcomes[row.step], row.path), row);
  });

  it('is deterministic: a second run gives byte-identical step data (AF-13)', () => {
    expect(JSON.stringify(runPlan(file).outcomes)).toBe(JSON.stringify(outcomes));
  });
});

describe('the revision step of SC-EQP-02 (shell 12 mm)', () => {
  it('is accepted by update_equipment_parameters and re-derives the weight (the code check that fails it is M3)', () => {
    const { plan, outcomes, final } = runPlan('sc-eqp-02-horizontal-drum-saddles.json');
    const step = plan.actions.findIndex((action) => action.command === 'update_equipment_parameters');
    expect((outcomes[step] as { changed: string[] }).changed).toEqual(['shellThickness']);
    const element = Object.values(final.building?.elements ?? {}).find((candidate) => candidate.category === 'equipment');
    expect(element?.category === 'equipment' && element.plant?.template.kind === 'vessel' && element.plant.template.shellThickness).toBe(
      12,
    );
  });
});
