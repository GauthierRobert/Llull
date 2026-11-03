/** SC-VIS-02 (viewpoint BCF round trip, VC-VIS-10 / 11) and SC-VIS-06 (clash review, VC-VIS-40 / 41): the validation plans replayed against their expected values. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';

interface Action {
  command: string;
  params: Record<string, unknown>;
  as?: string;
}
interface Expected {
  step: number;
  path: string;
  value: unknown;
  rel?: number;
  abs?: number;
}
const planOf = (file: string): { actions: Action[]; expected: Expected[] } =>
  JSON.parse(readFileSync(resolve(process.cwd(), `docs/plant/09-plant-visualization-review/validation/plans/${file}`), 'utf8')) as {
    actions: Action[];
    expected: Expected[];
  };

const resolveAliases = (value: unknown, aliases: Record<string, string>): unknown => {
  if (typeof value === 'string' && value.startsWith('$')) return aliases[value.slice(1)] ?? value;
  if (Array.isArray(value)) return value.map((item) => resolveAliases(item, aliases));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveAliases(item, aliases)]));
  return value;
};

/** `a.b[0].length`, `rows[?code=='X'].length`. */
function read(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const token of path.match(/[^.[\]]+|\[\?[^\]]+\]/g) ?? []) {
    const filter = /^\[\?(\w+)=='([^']*)'\]$/.exec(token);
    if (filter !== null && Array.isArray(current))
      current = current.filter((row) => (row as Record<string, unknown>)[filter[1] ?? ''] === filter[2]);
    else if (Array.isArray(current) && /^\d+$/.test(token)) current = current[Number(token)];
    else current = (current as Record<string, unknown> | undefined)?.[token];
  }
  return current;
}

function replay(file: string): { results: CommandResult[]; expected: Expected[] } {
  const plan = planOf(file);
  let document = createEmptyDocument();
  const aliases: Record<string, string> = {};
  const results: CommandResult[] = [];
  for (const action of plan.actions) {
    const result = execute(document, action.command, resolveAliases(action.params, aliases) as Record<string, unknown>);
    results.push(result);
    document = result.document;
    const created = result.affected[0];
    if (action.as !== undefined && created !== undefined) aliases[action.as] = created;
  }
  return { results, expected: plan.expected };
}

function checkExpected(file: string): void {
  const { results, expected } = replay(file);
  expect(results.filter((result) => result.error !== undefined).map((result) => result.summary)).toEqual([]);
  for (const row of expected) {
    const actual = read(results[row.step]?.data, row.path);
    const label = `step ${row.step} ${row.path}`;
    if (typeof row.value === 'number' && typeof actual === 'number') {
      const tolerance = row.abs ?? Math.abs(row.value) * (row.rel ?? 0);
      expect(Math.abs(actual - row.value), label).toBeLessThanOrEqual(tolerance);
    } else expect(actual, label).toEqual(row.value);
  }
}

describe('validation plans of the VIS-M5 commands', () => {
  it('SC-VIS-02: a BCF viewpoint survives export and import (metres, mm document)', () =>
    checkExpected('sc-vis-02-viewpoint-bcf-roundtrip.json'));
  it('SC-VIS-06: a pipe through a vessel gives one framed issue, and a re-run is idempotent', () =>
    checkExpected('sc-vis-06-clash-review.json'));
});
