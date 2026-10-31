/**
 * Plant 08 DAT M1 + M2: runs the scenario plans of the validation pack (`validation/plans/*.json`) step by step through `execute` (the path of `llull run plan.json`;
 * `as` binds the first affected id, `$alias` is replaced in params and expected values) and compares each `expected` row with the step's `data` / `error`.
 * Steps flagged `unbuilt` (the `schema` param of export_ifc: M3; valve_list: M5) or whose command is not registered are skipped, and so are their rows. DAT-M2 added the plant_report steps 15-19 of SC-DAT-01.
 * SC-DAT-03 uses onError "continue": a refused step is an outcome, not a failure (VC-DAT-12).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute, getCommand } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { PACK } from './dataFixtures';

interface Expected {
  step: number;
  path: string;
  value?: unknown;
  abs?: number;
}
interface Plan {
  id: string;
  actions: Array<{ command: string; params: Record<string, unknown>; as?: string; unbuilt?: boolean }>;
  expected: Expected[];
}

/** `a.b[0].c` and `findings[code=X].ids` lookups. */
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

const bind = (value: unknown, aliases: Map<string, string>): unknown => {
  if (typeof value === 'string') return value.startsWith('$') ? (aliases.get(value.slice(1)) ?? value) : value;
  if (Array.isArray(value)) return value.map((item) => bind(item, aliases));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bind(item, aliases)]));
  return value;
};

type Outcome = Record<string, unknown> & { error: { code: string } | undefined; rejected: boolean };

function runPlan(name: string): { plan: Plan; outcomes: Array<Outcome | null>; aliases: Map<string, string>; final: CadDocument } {
  const plan = JSON.parse(readFileSync(path.join(PACK, 'plans', name), 'utf8')) as Plan;
  let doc: CadDocument = createEmptyDocument();
  const aliases = new Map<string, string>();
  const outcomes = plan.actions.map((action) => {
    if (getCommand(action.command) === undefined || action.unbuilt === true) return null;
    const result = execute(doc, action.command, bind(action.params, aliases));
    doc = result.document;
    if (action.as !== undefined && result.affected[0] !== undefined) aliases.set(action.as, result.affected[0]);
    return { ...(result.data as Record<string, unknown> | undefined), error: result.error, rejected: result.rejected === true };
  });
  return { plan, outcomes, aliases, final: doc };
}

function compare(actual: unknown, row: Expected, aliases: Map<string, string>): void {
  const wanted = bind(row.value, aliases);
  if (typeof wanted === 'number' && typeof actual === 'number')
    expect(Math.abs(actual - wanted), `${row.path}: ${actual} vs ${wanted}`).toBeLessThanOrEqual(row.abs ?? 0);
  else expect(actual, row.path).toEqual(wanted);
}

describe.each([
  ['sc-dat-01-tank-pump-mvp.json', 'SC-DAT-01'],
  ['sc-dat-03-data-errors.json', 'SC-DAT-03'],
])('scenario plan %s', (file, id) => {
  const { plan, outcomes, aliases, final } = runPlan(file);

  it('meets the expected rows of every built step', () => {
    expect(plan.id).toBe(id);
    const built = plan.expected.filter((row) => outcomes[row.step] != null);
    expect(built.length).toBeGreaterThanOrEqual(id === 'SC-DAT-01' ? 11 : 7);
    for (const row of built) compare(pick(outcomes[row.step], row.path), row, aliases);
  });

  it('is deterministic: a second run gives byte-identical step data and the same plant data', () => {
    const again = runPlan(file);
    const plantSteps = (list: Array<Outcome | null>): string =>
      JSON.stringify(list.filter((_outcome, index) => plan.actions[index]?.command !== 'export_ifc'));
    expect(plantSteps(again.outcomes)).toBe(plantSteps(outcomes));
    expect(again.final.plant?.data).toEqual(final.plant?.data);
  });
});

describe('SC-DAT-01 (VC-DAT-01, 11, 12)', () => {
  it('tags T-101, P-101, 150-P-1001-A1A and 100-P-1002-A1A, writes them into the model and passes the check', () => {
    const { outcomes, final } = runPlan('sc-dat-01-tank-pump-mvp.json');
    const tags = Object.values(final.plant?.data?.objects ?? {}).map((object) => object.tag);
    expect(tags).toEqual(['T-101', 'P-101', '150-P-1001-A1A', '100-P-1002-A1A']);
    expect(outcomes.filter((outcome) => outcome?.rejected === true)).toEqual([]);
    const marks = Object.values(final.building?.elements ?? {}).flatMap((element) =>
      element.category === 'equipment' ? [element.mark] : [],
    );
    expect(marks).toEqual(['T-101', 'P-101']);
  });

  it('replay of the feature history re-mints the same plant data (VC-DAT-11)', () => {
    const { final } = runPlan('sc-dat-01-tank-pump-mvp.json');
    const replayed = execute(final, 'replay_history', {}).document;
    expect(replayed.plant?.data).toEqual(final.plant?.data);
  });
});

describe('SC-DAT-03 (VC-DAT-12)', () => {
  it('refuses the hand-typed tag and the duplicate with stable codes and finds the two data errors', () => {
    const { outcomes } = runPlan('sc-dat-03-data-errors.json');
    expect(outcomes[6]?.error?.code).toBe('DAT_TAG_FORMAT');
    expect(outcomes[8]?.error?.code).toBe('DAT_TAG_DUPLICATE');
    const findings = (outcomes[12]?.['findings'] ?? []) as Array<{ code: string }>;
    expect(findings.map((finding) => finding.code).sort()).toEqual(['DAT_LINE_END_UNRESOLVED', 'DAT_REQUIRED_PROPERTY_MISSING']);
  });
});
