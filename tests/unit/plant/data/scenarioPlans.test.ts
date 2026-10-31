/**
 * Plant 08 DAT M1 - M4 (SC-DAT-04 Excel round trip and SC-DAT-05 ifc_summary of the buildingSMART samples run since M4): runs the scenario plans of the validation pack (`validation/plans/*.json`) step by step through `execute` (the path of `llull run plan.json`;
 * `as` binds the first affected id, `$alias` is replaced in params and expected values) and compares each `expected` row with the step's `data` / `error`.
 * Steps flagged `unbuilt` (the sibling commands of SC-DAT-02; its valve_list is built since M5) or whose command is not registered are skipped, and so are their rows. DAT-M2 added the plant_report steps 15-19 of SC-DAT-01, DAT-M3 the export_ifc `schema` step 21.
 * SC-DAT-03 uses onError "continue": a refused step is an outcome, not a failure (VC-DAT-12).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute, getCommand } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { PACK, scDat02Document } from './dataFixtures';

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

/** A plan step cannot read a file: `fileRef` (xlsx / csv) and `ifcRef` name one relative to the pack, the test sends its content. */
function withFiles(params: unknown): unknown {
  if (params === null || typeof params !== 'object') return params;
  const { fileRef, ifcRef, ...rest } = params as Record<string, unknown>;
  if (typeof fileRef === 'string') return { ...rest, fileBase64: readFileSync(path.join(PACK, fileRef)).toString('base64') };
  if (typeof ifcRef === 'string') return { ...rest, ifc: readFileSync(path.join(PACK, ifcRef), 'utf8') };
  return params;
}

type Outcome = Record<string, unknown> & { error: { code: string } | undefined; refused: boolean };

function runPlan(name: string): { plan: Plan; outcomes: Array<Outcome | null>; aliases: Map<string, string>; final: CadDocument } {
  const plan = JSON.parse(readFileSync(path.join(PACK, 'plans', name), 'utf8')) as Plan;
  let doc: CadDocument = createEmptyDocument();
  const aliases = new Map<string, string>();
  const step = (action: Plan['actions'][number]): Outcome | null => {
    if (getCommand(action.command) === undefined || action.unbuilt === true) return null;
    const planRef = action.command === 'build_project' ? action.params['planRef'] : undefined;
    if (typeof planRef === 'string') {
      // `build_project { planRef, steps: "a-b" }` is the shorthand of the CLI: replay those steps of the referenced plan
      const [from = 0, to = 0] = String(action.params['steps']).split('-').map(Number);
      const referenced = JSON.parse(readFileSync(path.join(PACK, 'plans', planRef), 'utf8')) as Plan;
      for (const inner of referenced.actions.slice(from, to + 1)) step(inner);
      return null;
    }
    const result = execute(doc, action.command, withFiles(bind(action.params, aliases)));
    doc = result.document;
    if (action.as !== undefined && result.affected[0] !== undefined) aliases.set(action.as, result.affected[0]);
    return { ...(result.data as Record<string, unknown> | undefined), error: result.error, refused: result.rejected === true };
  };
  const outcomes = plan.actions.map(step);
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
  ['sc-dat-04-excel-roundtrip.json', 'SC-DAT-04'],
  ['sc-dat-05-ifc-summary-bsi.json', 'SC-DAT-05'],
])('scenario plan %s', (file, id) => {
  const { plan, outcomes, aliases, final } = runPlan(file);

  it('meets the expected rows of every built step', () => {
    expect(plan.id).toBe(id);
    // `cellsEqualTo` compares the export with the openpyxl fixture cell for cell: exportData.test.ts does it with the xlsx reader of the tests
    const runnable = plan.expected.filter((row) => !row.path.endsWith('cellsEqualTo'));
    const built = runnable.filter((row) => outcomes[row.step] != null);
    if (id !== 'SC-DAT-03') expect(built, `every expected row of ${id} runs`).toHaveLength(runnable.length);
    else expect(built.length).toBeGreaterThanOrEqual(7);
    for (const row of built) compare(pick(outcomes[row.step], row.path), row, aliases);
  });

  it('is deterministic: a second run gives byte-identical step data and the same plant data', () => {
    const again = runPlan(file);
    // GlobalIds are salted with the building uid, which differs between two fresh documents; the file text of one document is compared in ifc4x3.test.ts.
    const stable = (list: Array<Outcome | null>): string =>
      JSON.stringify(list, (key, value: unknown) => (key === 'ifc' && typeof value === 'string' ? value.length : value));
    expect(stable(again.outcomes)).toBe(stable(outcomes));
    expect(again.final.plant?.data).toEqual(final.plant?.data);
  });
});

describe('SC-DAT-01 (VC-DAT-01, 11, 12)', () => {
  it('tags T-101, P-101, 150-P-1001-A1A and 100-P-1002-A1A, writes them into the model and passes the check', () => {
    const { outcomes, final } = runPlan('sc-dat-01-tank-pump-mvp.json');
    const tags = Object.values(final.plant?.data?.objects ?? {}).map((object) => object.tag);
    expect(tags).toEqual(['T-101', 'P-101', '150-P-1001-A1A', '100-P-1002-A1A']);
    expect(outcomes.filter((outcome) => outcome?.refused === true)).toEqual([]);
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

describe('SC-DAT-02 (VC-DAT-04, 07; the sibling steps are provisional in the pack, so the scene is built with the real 03 / 02 commands)', () => {
  const plan = JSON.parse(readFileSync(path.join(PACK, 'plans', 'sc-dat-02-inline-valves-v1.json'), 'utf8')) as Plan;
  const doc = scDat02Document();

  it('the valve_list step is a built command and the expected rows 13 and 14 hold on the scene', () => {
    const step = plan.actions[13];
    expect(step?.command).toBe('plant_report');
    expect(step?.unbuilt).toBeUndefined();
    const report = execute(doc, 'plant_report', step?.params ?? {});
    const check = execute(doc, 'check_plant_data', plan.actions[14]?.params ?? {});
    for (const row of plan.expected.filter((entry) => entry.step === 13 || entry.step === 14))
      compare(pick(row.step === 13 ? report.data : check.data, row.path), row, new Map());
  });

  it('the report is the same after a replay of the feature history', () => {
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(execute(replayed, 'plant_report', { kind: 'valve_list' }).data).toEqual(
      execute(doc, 'plant_report', { kind: 'valve_list' }).data,
    );
  });
});
