/**
 * Plant 05 ISO M2: the pack's scenario plans SC-ISO-01 and SC-ISO-07 run step by step through `execute` (the path of `llull run plan.json`; `as` binds the first affected id).
 * Steps whose command is not registered yet (`check_isometric`, M3) are skipped with their rows. The `harness` of the plan inlines the fixture text and the TAB mutation.
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
    return filter ? value.find((item: Record<string, unknown>) => item[filter[1] as string] === filter[2]) : value[Number(index)];
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

describe('SC-ISO-01: parse the sample PCF, then welds, spools, cut lists, BOM and export (VC-ISO-01, 03, 05..09)', () => {
  const { plan, outcomes } = run('sc-iso-01-parse-sample-pcf.json');

  it('every step of the plan up to check_isometric is built and runs', () => {
    expect(plan.actions.filter((action) => getCommand(action.command) === undefined).map((action) => action.command)).toEqual([
      'check_isometric',
    ]);
    expect(outcomes.filter((outcome, index) => outcome === null && index < plan.actions.length - 1)).toEqual([]);
  });

  it('meets every expected row of the built steps', () => {
    const built = plan.expected.filter((row) => outcomes[row.step] != null);
    expect(built.map((row) => row.step)).toEqual([1, 1, 1, 3, 3, 5, 6, 7, 8, 8, 9]);
    for (const row of built) {
      const actual = pickRow(outcomes[row.step], row.path);
      if (typeof row.value === 'number' && typeof actual === 'number')
        expect(Math.abs(actual - row.value), row.path).toBeLessThanOrEqual(row.abs ?? 0);
      else if (Array.isArray(row.value) && row.abs !== undefined)
        (row.value as number[]).forEach((value, at) =>
          expect(Math.abs(((actual as number[])[at] as number) - value), `${row.path}[${at}]`).toBeLessThanOrEqual(row.abs as number),
        );
      else expect(actual, row.path).toEqual(row.value);
    }
  });

  it('is deterministic: a second run gives the same step data', () => {
    expect(JSON.stringify(run('sc-iso-01-parse-sample-pcf.json').outcomes)).toBe(JSON.stringify(outcomes));
  });
});

describe('SC-ISO-07: broken inputs (the built part: TAB refusal, a 14 m legacy line against the user shipping envelope)', () => {
  const { plan, outcomes, final } = run('sc-iso-07-check-errors.json');

  it('the TAB on line 14 is refused with its code and path, and the rule is stored with its source', () => {
    for (const row of plan.expected.filter((entry) => entry.step === 1))
      expect(pickRow(outcomes[row.step], row.path), row.path).toEqual(row.value);
    expect(final.plant?.fabrication?.rules?.maxSpool).toMatchObject({
      lengthMm: 12000,
      widthMm: 3000,
      heightMm: 3000,
      source: 'project shipping envelope (user given)',
    });
  });

  it('the 14 m legacy pipe is a single spool over the 12 m envelope: split_spools names it E-401-SP01 (the spool part of VC-ISO-16)', () => {
    const refused = execute(final, 'split_spools', { lineId: 'E-401' });
    expect(refused.error?.code).toBe('ISO_SPOOL_TOO_LARGE');
    expect(refused.error?.ids).toEqual(['E-401-SP01']);
    expect(refused.document).toBe(final);
  });
});
