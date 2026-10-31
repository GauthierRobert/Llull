/**
 * Plant 05 ISO M2 / M3: the pack's scenario plans SC-ISO-01, 03, 04 and 07 run step by step through `execute` (the path of `llull run plan.json`; `as` binds the first affected id).
 * Steps whose command is not registered yet are skipped with their rows. The `harness` of the plan inlines the fixture text and the TAB mutation.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute, getCommand } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

const PACK = path.resolve(__dirname, '../../../../docs/plant/05-isometrics-fabrication/validation');

interface Row {
  step: number;
  path: string;
  value?: unknown;
  abs?: number;
}
interface Plan {
  id: string;
  actions: Array<{ command: string; params: Record<string, unknown>; as?: string }>;
  expected: Row[];
  harness?: { mutate?: Array<{ action: number; replaceLine: number; with: string }> };
}
type Outcome = { data: unknown; error: { code: string; paths: readonly string[] } | undefined };

/** `a.b[0].c`, `x[code=Y].ids`, `x[*].k` lookups. */
function pick(root: unknown, expression: string): unknown {
  return expression.split('.').reduce<unknown>((node, part) => {
    const match = /^([^[]*)(?:\[(.+)\])?$/.exec(part);
    const key = match?.[1] ?? part;
    const value = (node as Record<string, unknown> | undefined)?.[key];
    const index = match?.[2];
    if (index === undefined || !Array.isArray(value)) return value;
    if (index === '*') return value;
    const filter = /^(\w+)=(.+)$/.exec(index);
    return filter ? value.find((item: Record<string, unknown>) => String(item[filter[1] as string]) === filter[2]) : value[Number(index)];
  }, root);
}

function pickRow(outcome: unknown, row: string): unknown {
  const star = row.indexOf('[*].');
  if (star < 0) return pick(outcome, row);
  const list = pick(outcome, row.slice(0, star)) as unknown[];
  return list.map((item) => pick(item, row.slice(star + 4)));
}

function run(file: string): { plan: Plan; outcomes: Array<Outcome | null>; final: CadDocument } {
  const plan = JSON.parse(readFileSync(path.join(PACK, 'plans', file), 'utf8')) as Plan;
  let doc: CadDocument = createEmptyDocument();
  const outcomes = plan.actions.map((action, index) => {
    if (getCommand(action.command) === undefined) return null;
    const params = { ...action.params };
    if (typeof params['text'] === 'string' && params['text'].startsWith('<data/')) {
      let text = readFileSync(path.join(PACK, 'data', 'iso-01-L101-dn100.pcf'), 'utf8').replace(/\r\n/g, '\n');
      for (const edit of plan.harness?.mutate ?? [])
        if (edit.action === index)
          text = text
            .split('\n')
            .map((line, at) => (at === edit.replaceLine - 1 ? edit.with : line))
            .join('\n');
      params['text'] = text;
    }
    const result = execute(doc, action.command, params);
    doc = result.document;
    return { data: result.data, error: result.error };
  });
  return { plan, outcomes, final: doc };
}

/** Every expected row of the given steps (or of every built step) holds in the outcomes. */
function expectRows(plan: Plan, outcomes: Array<Outcome | null>, steps?: readonly number[]): void {
  for (const row of plan.expected.filter((entry) => outcomes[entry.step] != null && (steps === undefined || steps.includes(entry.step)))) {
    const actual = pickRow(outcomes[row.step], row.path);
    if (row.value === 'present') expect(actual, row.path).toBeDefined();
    else if (typeof row.value === 'number' && typeof actual === 'number')
      expect(Math.abs(actual - row.value), row.path).toBeLessThanOrEqual(row.abs ?? 0);
    else if (Array.isArray(row.value) && row.abs !== undefined)
      (row.value as number[]).forEach((value, at) =>
        expect(Math.abs(((actual as number[])[at] as number) - value), `${row.path}[${at}]`).toBeLessThanOrEqual(row.abs as number),
      );
    else expect(actual, row.path).toEqual(row.value);
  }
}

const unbuilt = (plan: Plan): string[] =>
  plan.actions.filter((action) => getCommand(action.command) === undefined).map((action) => action.command);

describe('SC-ISO-01: parse the sample PCF, then welds, spools, cut lists, BOM, export and check (VC-ISO-01, 03, 05..09)', () => {
  const { plan, outcomes } = run('sc-iso-01-parse-sample-pcf.json');

  it('every step of the plan is built and runs', () => {
    expect(unbuilt(plan)).toEqual([]);
    expect(outcomes.every((outcome) => outcome !== null)).toBe(true);
  });

  it('meets every expected row, the check_isometric one (ok on a clean line) included', () => {
    expect(plan.expected.map((row) => row.step)).toEqual([1, 1, 1, 3, 3, 5, 6, 7, 8, 8, 9, 10]);
    expectRows(plan, outcomes);
  });

  it('is deterministic: a second run gives the same step data', () => {
    expect(JSON.stringify(run('sc-iso-01-parse-sample-pcf.json').outcomes)).toBe(JSON.stringify(outcomes));
  });
});

describe('SC-ISO-03: the final isometric of L-101 on A3 (VC-ISO-10, 11)', () => {
  const { plan, outcomes } = run('sc-iso-03-isometric-sheet.json');

  it('meets every expected row: axes, north arrow, string dimensions closing to 5000, one sheet, 13 welds', () => {
    expect(unbuilt(plan)).toEqual([]);
    expect(plan.expected).toHaveLength(9);
    expectRows(plan, outcomes);
  });

  it('writes the svg and the dxf of the sheet and byte-identical files on a second run (VC-ISO-17)', () => {
    const files = (outcomes[2]?.data as { files: Array<{ name: string; sha256: string }> }).files;
    expect(files.map((file) => file.name)).toEqual(['L-101_iso_sheet1.svg', 'L-101_iso_sheet1.dxf']);
    const again = (run('sc-iso-03-isometric-sheet.json').outcomes[2]?.data as { files: Array<{ sha256: string }> }).files;
    expect(again.map((file) => file.sha256)).toEqual(files.map((file) => file.sha256));
  });
});

describe('SC-ISO-04: a drain falling 100 mm over 10 m (VC-ISO-12)', () => {
  const { plan, outcomes } = run('sc-iso-04-sloped-line.json');

  it('carries SLOPE 1:100, 1 %, 0.5729386977 degrees and the fall toward +X', () => {
    expect(unbuilt(plan)).toEqual([]);
    expectRows(plan, outcomes);
  });
});

describe('SC-ISO-07: broken inputs (TAB refusal; a 14 m legacy line against the user shipping envelope) (VC-ISO-02, 16)', () => {
  const { plan, outcomes, final } = run('sc-iso-07-check-errors.json');

  it('the TAB on line 14 is refused with its code and path, and the rule is stored with its source', () => {
    expect(unbuilt(plan)).toEqual([]);
    expectRows(plan, outcomes, [1]);
    expect(final.plant?.fabrication?.rules?.maxSpool).toMatchObject({
      lengthMm: 12000,
      widthMm: 3000,
      heightMm: 3000,
      source: 'project shipping envelope (user given)',
    });
  });

  it('check_isometric names the spool E-401-SP01 over the limit, the open ends, and is not ok', () => {
    expectRows(plan, outcomes, [4]);
    expect((outcomes[4]?.data as { ok: boolean }).ok).toBe(false);
  });

  it('split_spools refuses the same spool with the same code and id', () => {
    const refused = execute(final, 'split_spools', { lineId: 'E-401' });
    expect(refused.error?.code).toBe('ISO_SPOOL_TOO_LARGE');
    expect(refused.error?.ids).toEqual(['E-401-SP01']);
    expect(refused.document).toBe(final);
  });
});
