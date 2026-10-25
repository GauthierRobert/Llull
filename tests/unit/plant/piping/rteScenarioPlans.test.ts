/**
 * Plant 02 RTE: runs the validation pack's scenario plans (`validation/plans/sc-rte-*.json`) through `build_project` (the path of
 * `llull run plan.json`) and compares each `expected` row with the step's `data` / `error`. `harness.inline` fixtures are inlined first. Steps
 * whose command is not registered yet stay unchecked; the plan's `unbuilt` list must say exactly
 * which commands those are (a stale list fails), and `blockedFrom` marks the first step whose rows depend on an unbuilt step.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute, getCommand } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';

const PLANS = path.resolve(__dirname, '../../../../docs/plant/02-spec-driven-routing/validation/plans');

interface Expected {
  step?: number;
  path: string;
  value?: unknown;
  abs?: number;
  rel?: number;
  contains?: string;
}
interface Action {
  command: string;
  params: Record<string, unknown>;
}
interface Case {
  id: string;
  actions: Action[];
  expected: Expected[];
}
interface Plan {
  id: string;
  unbuilt: string[];
  blockedFrom?: number;
  harness?: { inline?: Record<string, string> };
  prefix?: Action[];
  actions?: Action[];
  cases?: Case[];
  expected?: Expected[];
}
interface Step {
  ok: boolean;
  command: string;
  summary: string;
  data?: unknown;
  error?: { code: string; ids: string[]; paths: string[]; remediation: string; detail?: unknown };
}

function load(name: string): Plan {
  const plan = JSON.parse(readFileSync(path.join(PLANS, name), 'utf8')) as Plan;
  for (const [target, file] of Object.entries(plan.harness?.inline ?? {})) {
    const match = /^(actions|prefix)\[(\d+)\]\.params\.(\w+)$/.exec(target);
    const list = match === null ? undefined : plan[match[1] as 'actions' | 'prefix'];
    if (match !== null && list !== undefined)
      (list[Number(match[2])] as Action).params[match[3] as string] = JSON.parse(readFileSync(path.join(PLANS, file), 'utf8'));
  }
  return plan;
}

/** `a.b[2].c`, `list[*].key`, `list[?dn==150].cutLengthMm` (a property of a list maps over it), `issues[?code=='X'].length`. */
function pick(root: unknown, expression: string): unknown {
  const tokens = [...expression.matchAll(/([^.[\]]+)|\[(\*|\d+|\?[^\]]+)\]/g)].map((m) => (m[1] ?? `[${m[2]}]`) as string);
  const walk = (node: unknown, rest: string[]): unknown => {
    const [head, ...tail] = rest;
    if (head === undefined) return node;
    if (head === '[*]') return Array.isArray(node) ? node.map((item) => walk(item, tail)) : undefined;
    const filter = /^\[\?(\w+)(==|!=)(?:'(.*)'|(-?\d+(?:\.\d+)?))\]$/.exec(head);
    if (filter !== null && Array.isArray(node)) {
      const [, key, operator, text, number] = filter;
      const wanted = number === undefined ? text : Number(number);
      return walk(
        node.filter((item: Record<string, unknown>) => (operator === '==') === (item[key as string] === wanted)),
        tail,
      );
    }
    const index = /^\[(\d+)\]$/.exec(head);
    if (index !== null) return walk(Array.isArray(node) ? node[Number(index[1])] : undefined, tail);
    if (Array.isArray(node) && head !== 'length') return node.map((item) => walk(item, rest));
    return walk((node as Record<string, unknown> | undefined)?.[head], tail);
  };
  return walk(root, tokens);
}

function close(actual: unknown, expected: unknown, tolerance: number, where: string): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    expect(Math.abs(actual - expected), `${where}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
  } else if (Array.isArray(expected) && Array.isArray(actual)) {
    expect(actual.length, where).toBe(expected.length);
    expected.forEach((value, i) => close(actual[i], value, tolerance, `${where}[${i}]`));
  } else if (expected !== null && typeof expected === 'object' && actual !== null && typeof actual === 'object') {
    for (const [key, value] of Object.entries(expected))
      close((actual as Record<string, unknown>)[key], value, tolerance, `${where}.${key}`);
  } else expect(actual, where).toEqual(expected);
}

/** Alias -> ids of the last `run` (`$name` in an expected value means the first id the step with `as: name` produced). */
let aliases: Record<string, string[]> = {};

function run(actions: Action[]): Step[] {
  const result = execute(createEmptyDocument(), 'build_project', { actions, onError: 'continue' });
  const data = result.data as { steps: Step[]; aliases?: Record<string, string[]> };
  aliases = data.aliases ?? {};
  return data.steps;
}

function resolved(value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('$')) return aliases[value.slice(1)]?.[0] ?? value;
  return Array.isArray(value) ? value.map(resolved) : value;
}

function check(steps: Step[], offset: number, rows: Expected[], blockedFrom: number): number {
  let checked = 0;
  for (const row of rows) {
    const index = row.step ?? 0;
    const step = steps[offset + index];
    if (step === undefined || index >= blockedFrom || step.error?.code === 'CMD_UNKNOWN') continue;
    const actual = pick(step, row.path);
    if (row.contains !== undefined) expect(String(actual), `${row.path} contains`).toContain(row.contains);
    else
      close(
        actual,
        resolved(row.value),
        row.abs ?? (row.rel === undefined ? 0 : Math.abs(row.value as number) * row.rel),
        `step ${index} ${row.path}`,
      );
    checked += 1;
  }
  return checked;
}

const commandsOf = (plan: Plan): Set<string> =>
  new Set(
    [...(plan.prefix ?? []), ...(plan.actions ?? []), ...(plan.cases ?? []).flatMap((c) => c.actions)].map((action) => action.command),
  );

describe.each([
  'sc-rte-01-pump-to-vessel.json',
  'sc-rte-02-pump-discharge-gate-valve.json',
  'sc-rte-03-header-branches.json',
  'sc-rte-04-gravity-drain-slope.json',
  'sc-rte-05-routing-refusals.json',
  'sc-rte-06-move-with-connected.json',
  'sc-rte-07-insulated-hot-line.json',
  'sc-rte-08-auto-route-v2.json',
  'sc-rte-09-legacy-pipe-run-conversion.json',
  'sc-rte-10-socket-weld-line.json',
  'sc-rte-11-threaded-line.json',
  'sc-rte-12-eccentric-reducer.json',
  'sc-rte-13-trimmed-elbow-and-bend.json',
  'sc-rte-14-valve-operator-clash.json',
  'sc-rte-15-slope-preserving-stretch.json',
  'sc-rte-16-supports-on-a-run.json',
  'sc-rte-17-supports-follow-stretch.json',
  'sc-rte-18-heat-tracing-and-loss.json',
  'sc-rte-19-pcf-small-line.json',
  'sc-rte-20-ifc-ports-small-line.json',
  'sc-rte-21-pipe-step-needs-kernel.json',
  'sc-rte-22-level-from-elevation.json',
  'sc-rte-23-convert-replace-moves-supports.json',
  'sc-rte-24-auto-route-around-insulated-run.json',
  'sc-rte-25-auto-route-lines-reorder.json',
])('scenario plan %s', (file) => {
  const plan = load(file);

  it('lists as unbuilt exactly the commands that are not registered', () => {
    const missing = [...commandsOf(plan)].filter((name) => getCommand(name) === undefined).sort();
    expect([...plan.unbuilt].sort()).toEqual(missing);
  });

  it('runs every built step and meets the expected rows of those steps', () => {
    const blockedFrom = plan.blockedFrom ?? Number.POSITIVE_INFINITY;
    let checked = 0;
    if (plan.cases === undefined) {
      const steps = run(plan.actions ?? []);
      checked += check(steps, 0, plan.expected ?? [], blockedFrom);
      // Every step before the first unbuilt or blocked one succeeded.
      const unbuilt = steps.findIndex((step) => step.error?.code === 'CMD_UNKNOWN');
      const limit = Math.min(unbuilt < 0 ? steps.length : unbuilt, blockedFrom);
      expect(steps.slice(0, limit).every((step) => step.ok)).toBe(true);
    } else {
      for (const c of plan.cases) {
        const prefix = plan.prefix ?? [];
        const steps = run([...prefix, ...c.actions]);
        expect(
          steps.slice(0, prefix.length).every((step) => step.ok),
          `${c.id}: prefix`,
        ).toBe(true);
        checked += check(steps, prefix.length, c.expected, blockedFrom);
      }
    }
    if (plan.blockedFrom === undefined) expect(checked).toBeGreaterThan(0);
  });
});
