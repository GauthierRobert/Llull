/** Plant 04 PID M4: the validation plans SC-PID-01, 02 and 05 run step by step through `execute`, every `expected` row compared with the step's answer (VC-PID-08, 09, 10, 12). */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { PID_PACK } from './dexpiFixtures';

interface Expected {
  step: number;
  path: string;
  value: unknown;
}
interface Plan {
  actions: Array<{ command: string; params: Record<string, unknown>; as?: string }>;
  expected: Expected[];
}

const readPlan = (file: string): Plan => JSON.parse(readFileSync(path.join(PID_PACK, 'plans', file), 'utf8')) as Plan;

/** `a.b[0].c`, `rows[?col=='x'].prop`, `rows[?col=='x'][*].prop`, `rows[*].prop`, `.length`. */
function pick(root: unknown, expression: string): unknown {
  const tokens = [...expression.matchAll(/\.?([A-Za-z_]\w*)|\[(\d+)\]|\[\?(\w+)=='([^']*)'\]|\[\*\]/g)];
  let node: unknown = root;
  let mapped = false;
  let filtered = false;
  for (const token of tokens) {
    const [text, name, index, column, wanted] = token;
    if (name !== undefined) {
      if (Array.isArray(node) && name === 'length') node = node.length;
      else if (Array.isArray(node) && mapped) node = node.map((entry) => (entry as Record<string, unknown>)[name]);
      else if (Array.isArray(node) && filtered) node = (node[0] as Record<string, unknown> | undefined)?.[name];
      else node = (node as Record<string, unknown> | undefined)?.[name];
      mapped = false;
      filtered = false;
    } else if (index !== undefined) node = (node as unknown[])[Number(index)];
    else if (column !== undefined) {
      node = (node as Array<Record<string, unknown>>).filter((entry) => entry[column] === wanted);
      filtered = true;
    } else if (text === '[*]') {
      mapped = true;
      filtered = false;
    }
  }
  return node;
}

function runPlan(plan: Plan): { results: CommandResult[]; doc: CadDocument } {
  let doc: CadDocument = createEmptyDocument();
  const bindings = new Map<string, string>();
  const resolve = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const file = /^@file:(.+)$/.exec(value)?.[1];
      if (file !== undefined) return readFileSync(path.join(PID_PACK, file.replace(/^validation\//, '')), 'utf8');
      return value.startsWith('$') ? (bindings.get(value.slice(1)) ?? value) : value;
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
    return value;
  };
  const results = plan.actions.map((action) => {
    const result = execute(doc, action.command, resolve(action.params));
    doc = result.document;
    const first = result.affected[0];
    if (action.as !== undefined && first !== undefined) bindings.set(action.as, first);
    return result;
  });
  return { results, doc };
}

const answer = (result: CommandResult | undefined): unknown => ({ data: result?.data, error: result?.error });

function expectPlan(plan: Plan, results: readonly CommandResult[]): void {
  expect(plan.expected.length).toBeGreaterThan(0);
  for (const row of plan.expected) expect(pick(answer(results[row.step]), row.path), `step ${row.step} ${row.path}`).toEqual(row.value);
}

describe('SC-PID-01: import the DEXPI reference P&ID, read the lists, check it', () => {
  const plan = readPlan('sc-pid-01-import-dexpi-reference.json');
  const { results } = runPlan(plan);

  it('runs all 7 steps without a refusal', () => {
    expect(plan.actions.map((a) => a.command)).toEqual([
      'import_dexpi',
      'pid_report',
      'pid_report',
      'pid_report',
      'pid_report',
      'pid_report',
      'check_pid',
    ]);
    expect(results).toHaveLength(7);
    for (const result of results) expect(result.rejected, result.summary).toBeUndefined();
  });

  it('meets every expected row: counts, 11 lines, 11 valves, 4 instruments, 5 equipment, and the T4750 nozzle findings', () => {
    expectPlan(plan, results);
    expect(plan.expected.filter((row) => row.step >= 2).length).toBeGreaterThanOrEqual(8);
  });
});

describe('SC-PID-02: author, check, seed six faults, report', () => {
  const plan = readPlan('sc-pid-02-author-and-validate.json');
  const { results } = runPlan(plan);

  it('seeds the faults and refuses the duplicate tag at step 17', () => {
    expect(results[17]?.rejected).toBe(true);
    expect(results[17]?.error?.code).toBe('PID_TAG_DUPLICATE');
    for (const index of [11, 18, 19]) expect(results[index]?.rejected, results[index]?.summary).toBeUndefined();
  });

  it('meets every expected row: one OPC error before the seeds, each seeded fault exactly once after', () => {
    expectPlan(plan, results);
  });

  it('lists the three authored lines in natural line-number order with their endpoints', () => {
    const rows = (results[19]?.data as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows.map((r) => [r['lineNumber'], r['from'], r['to']])).toEqual([
      ['50-V-1003-A1', 'T-101/N2', 'free'],
      ['80-P-1002-A1', 'P-101/N2', 'OPC:OPC-1'],
      ['100-P-1001-A1', 'T-101/N1', 'P-101/N1'],
    ]);
    expect(rows.find((r) => r['lineNumber'] === '80-P-1002-A1')?.['inlineTags']).toBe('HV-102 FV-101 HV-103');
  });
});

describe('SC-PID-05: tag parsing', () => {
  const plan = readPlan('sc-pid-05-tag-parsing.json');
  const { results } = runPlan(plan);

  it('meets every expected row: FIC-101 decodes, FIC 032 has loop 032, the limit-mark tag is nonstandard', () => {
    expectPlan(plan, results);
    expect(results[2]?.rejected).toBe(true);
  });
});
