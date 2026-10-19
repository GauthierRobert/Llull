/**
 * `check` lines: a metric of an alias (or any read-only command + `path=`) compared with an expected value. Checks report; they never
 * change the document. `check_design` turns a failure into an error (CLI exit 1).
 */

import { execute, getCommand } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { ExecutionContext } from '@core/commands/types';
import { isRecord } from '@lib/isRecord';
import { DesignError } from './errors';
import type { CheckOp, Pair, Statement, ValueNode } from './parse';
import { bindCommand } from './schemaValue';
import { lengthFactor } from './units';

type CheckStatement = Extract<Statement, { kind: 'check' }>;

export interface CheckResult {
  readonly line: number;
  readonly metric: string;
  readonly of: string | null;
  readonly op: CheckOp;
  readonly expected: Expected;
  readonly actual: unknown;
  /** Absolute tolerance used, in the metric's unit. */
  readonly tolerance: number;
  readonly pass: boolean;
  /** Why the metric could not be read (query refused, path missing). */
  readonly note?: string;
}

/** What a check needs from the running design. */
export interface CheckScope {
  readonly doc: CadDocument;
  /** Context the queries run in (undefined: the current one). */
  readonly ctx: ExecutionContext | undefined;
  /** `alias` -> its first id when it is a live alias, else the text (data keyed by ids: path=bodies.wheel.massKg). */
  pathKey(text: string): string;
  /** Live ids of an alias (throws DESIGN_UNKNOWN_ALIAS / DESIGN_ALIAS_CONSUMED). */
  aliasIds(name: string, line: number): string[];
  /** Resolve a bound template (expressions, names, anchors) at the check's line. */
  resolve(template: unknown, line: number): unknown;
  /** Evaluate an expression text (units converted) with the current parameters / loop variables. */
  evaluate(text: string, line: number): number;
}

interface Metric {
  readonly command: string;
  readonly params: (id: string | null, unit: string | null) => Record<string, unknown>;
  readonly read: (data: unknown) => unknown;
  readonly needsOf: boolean;
  readonly unit: 'length' | 'mass' | 'none';
}

const field = (path: string) => (data: unknown) => readPath(data, path);
const items = (data: unknown): readonly Record<string, unknown>[] =>
  isRecord(data) && Array.isArray(data['items']) ? (data['items'] as Record<string, unknown>[]) : [];
const entity = (id: string | null): Record<string, unknown> => (id === null ? {} : { entityId: id });

/** Named metrics (contract-tested: each one reads a value on a fixture). */
export const METRICS: Readonly<Record<string, Metric>> = {
  bbox: { command: 'measure_bounding_box', params: entity, read: field('size'), needsOf: false, unit: 'length' },
  size: { command: 'measure_bounding_box', params: entity, read: field('size'), needsOf: false, unit: 'length' },
  min: { command: 'measure_bounding_box', params: entity, read: field('min'), needsOf: false, unit: 'length' },
  max: { command: 'measure_bounding_box', params: entity, read: field('max'), needsOf: false, unit: 'length' },
  volume: { command: 'mass_properties', params: entity, read: field('volume'), needsOf: true, unit: 'none' },
  mass: {
    command: 'mass_properties',
    params: (id, unit) => ({ ...entity(id), massUnit: unit ?? 'kg' }),
    read: field('mass'),
    needsOf: true,
    unit: 'mass',
  },
  dof: {
    command: 'check_mechanism',
    params: () => ({}),
    read: (data) =>
      items(data)
        .map((i) => readPath(i, 'values.mobility'))
        .find((v) => typeof v === 'number'),
    needsOf: false,
    unit: 'none',
  },
  hard_interferences: {
    command: 'check_assembly',
    params: (id) => (id === null ? {} : { ids: [id] }),
    read: (data) => items(data).filter((i) => i['code'] === 'FPR_PAIR_HARD').length,
    needsOf: false,
    unit: 'none',
  },
  issues: {
    command: 'check_model',
    params: () => ({}),
    read: (data) => (isRecord(data) && Array.isArray(data['issues']) ? data['issues'].length : undefined),
    needsOf: false,
    unit: 'none',
  },
};

const MASS_UNIT = /^(.*?)(kg|g|lb)$/;

type Expected = number | string | boolean | number[];

/** One key of a `path=`: the literal key, else (data keyed by ids) the id of the alias of that name. */
interface PathKey {
  readonly key: string;
  readonly id: string;
}

const child = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;

const step = (value: unknown, key: PathKey): unknown => child(value, key.key) ?? child(value, key.id);

/** `path=` of a check, without a leading `data.` (paths are relative to the command's data). */
function pathOf(statement: CheckStatement, scope: CheckScope): PathKey[] | null {
  const pair = statement.pairs.find((p) => p.key.join('.') === 'path');
  if (pair === undefined) return null;
  if (pair.value.kind !== 'word')
    throw new DesignError('DESIGN_BAD_VALUE', statement.line, 'path= takes a dotted path', 'Write path=a.b.0.');
  return pair.value.text
    .replace(/^data\./, '')
    .split('.')
    .filter((key) => key !== '')
    .map((key) => ({ key, id: scope.pathKey(key) }));
}

/** Why `path` did not resolve in `data`: where it stops and the keys available there. */
function missingPathNote(data: unknown, keys: readonly PathKey[]): string {
  const path = keys.map((k) => k.key).join('.');
  let value = data;
  let walked = 0;
  for (let next = keys[0]; next !== undefined && step(value, next) !== undefined; next = keys[walked]) {
    value = step(value, next);
    walked++;
  }
  const available = value !== null && typeof value === 'object' ? Object.keys(value).slice(0, 20).join(', ') : String(value);
  const stop =
    walked > 0
      ? ` (stops after "${keys
          .slice(0, walked)
          .map((k) => k.key)
          .join('.')}")`
      : '';
  return `path "${path}" not found in data${stop}; keys there: ${available === '' ? '(none)' : available}`;
}

/** Value at a dotted path (`size`, `values.mobility`, `items.0.code`, `issues.length`). */
function readPath(data: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => child(value, key), data);
}

/** Value at the keys of a `path=`. */
const readKeys = (data: unknown, keys: readonly PathKey[]): unknown => keys.reduce<unknown>(step, data);

/** Evaluate one check against the final document of the run. */
export function runCheck(statement: CheckStatement, scope: CheckScope): CheckResult {
  const { line } = statement;
  const metric = METRICS[statement.metric];
  const ofPair = statement.pairs.find((p) => p.key.join('.') === 'of');
  const of = ofPair?.value.kind === 'word' ? ofPair.value.text : null;
  if (ofPair !== undefined && of === null) throw new DesignError('DESIGN_BAD_VALUE', line, 'of= takes an alias', 'Write of=<alias>.');
  const id = of === null ? null : (scope.aliasIds(of, line)[0] ?? null);
  if (of !== null && id === null)
    throw new DesignError(
      'DESIGN_UNKNOWN_ALIAS',
      line,
      `alias ${of} names nothing to measure`,
      'Bind of= to a line that creates geometry.',
    );
  const massUnit = metric?.unit === 'mass' ? massUnitOf(statement.expected) : null;
  const path = pathOf(statement, scope);
  const query = metric === undefined ? genericQuery(statement, path, scope) : metricQuery(statement, metric, id, massUnit, path, scope);
  const result = execute(scope.doc, query.command, query.params, scope.ctx);
  const actual = result.error === undefined ? query.read(result.data) : undefined;
  const expected = expectedValue(statement.expected, metric?.unit ?? 'length', scope, line);
  if (statement.op === '~=' && expected === 0 && statement.tolerance === null)
    throw new DesignError('DESIGN_BAD_VALUE', line, '~= 0 has no relative tolerance', 'Give an absolute one: expect ~= 0 ± 0.5');
  const tolerance = toleranceOf(statement, expected, scope);
  const base = { line, metric: statement.metric, of, op: statement.op, expected, actual, tolerance };
  if (actual === undefined) {
    const note =
      result.error !== undefined ? result.error.remediation : path !== null ? missingPathNote(result.data, path) : result.summary;
    return { ...base, pass: false, note };
  }
  return { ...base, pass: compare(statement.op, actual, expected, tolerance) };
}

interface Query {
  readonly command: string;
  readonly params: Record<string, unknown>;
  readonly read: (data: unknown) => unknown;
}

/** Pairs of a check other than of= / path=: params for the query command. */
const queryPairs = (statement: CheckStatement): Pair[] => statement.pairs.filter((p) => !['of', 'path'].includes(p.key.join('.')));

function metricQuery(
  statement: CheckStatement,
  metric: Metric,
  id: string | null,
  massUnit: string | null,
  path: readonly PathKey[] | null,
  scope: CheckScope,
): Query {
  if (metric.needsOf && id === null)
    throw new DesignError('DESIGN_BAD_VALUE', statement.line, `check ${statement.metric} needs of=<alias>`, 'Add of=<alias>.');
  const def = getCommand(metric.command);
  const extra =
    def === undefined
      ? {}
      : (scope.resolve(bindCommand(def, queryPairs(statement), scope.doc, statement.line).params, statement.line) as Record<
          string,
          unknown
        >);
  const read = path === null ? metric.read : (data: unknown): unknown => readKeys(metric.read(data), path);
  return { command: metric.command, params: { ...extra, ...metric.params(id, massUnit) }, read };
}

/** `check <read-only command> <its params…> path=<data path> expect …`. */
function genericQuery(statement: CheckStatement, path: readonly PathKey[] | null, scope: CheckScope): Query {
  const { line } = statement;
  const def = getCommand(statement.metric);
  if (def === undefined || def.annotations?.readOnly !== true)
    throw new DesignError(
      'DESIGN_UNKNOWN_COMMAND',
      line,
      `"${statement.metric}" is neither a metric nor a read-only command`,
      `Metrics: ${Object.keys(METRICS).join(', ')}; or a read-only command with path=<data path>.`,
    );
  if (path === null)
    throw new DesignError('DESIGN_BAD_VALUE', line, `check ${def.name} needs path=<data path>`, 'Add path=, e.g. path=status.');
  const bound = bindCommand(def, queryPairs(statement), scope.doc, line);
  return { command: def.name, params: scope.resolve(bound.params, line) as Record<string, unknown>, read: (data) => readKeys(data, path) };
}

function massUnitOf(node: ValueNode): string | null {
  return node.kind === 'word' ? (MASS_UNIT.exec(node.text)?.[2] ?? null) : null;
}

function expectedValue(node: ValueNode, unit: Metric['unit'], scope: CheckScope, line: number): Expected {
  if (node.kind === 'list') return node.items.map((item) => Number(expectedValue(item, unit, scope, line)));
  if (node.kind === 'string') return node.value;
  if (node.kind !== 'word')
    throw new DesignError('DESIGN_BAD_VALUE', line, 'unsupported expected value', 'Write a number, a list or a word.');
  if (node.text === 'true' || node.text === 'false') return node.text === 'true';
  const text = unit === 'mass' ? (MASS_UNIT.exec(node.text)?.[1] ?? node.text) : node.text;
  if (/^[A-Za-z_]\w*$/.test(text) && !/^(pi|e)$/.test(text)) {
    try {
      return scope.evaluate(text, line);
    } catch {
      return text;
    }
  }
  return scope.evaluate(text, line);
}

function toleranceOf(statement: CheckStatement, expected: Expected, scope: CheckScope): number {
  const magnitude = Array.isArray(expected)
    ? Math.max(1, ...expected.map(Math.abs))
    : typeof expected === 'number'
      ? Math.abs(expected)
      : 0;
  const t = statement.tolerance;
  if (t === null) return statement.op === '~=' ? 0.01 * magnitude : 1e-6 * Math.max(1, magnitude);
  if (t.unit === '%') return (t.value / 100) * magnitude;
  if (t.unit === null || MASS_UNIT.test(t.unit)) return t.value;
  const factor = lengthFactor(t.unit, scope.doc);
  if (factor === null)
    throw new DesignError('DESIGN_UNIT_NOT_SUPPORTED', statement.line, `tolerance unit "${t.unit}"`, 'Use %, a length unit or none.');
  return t.value * factor;
}

function compare(op: CheckOp, actual: unknown, expected: Expected, tolerance: number): boolean {
  if (Array.isArray(expected))
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => compare(op, actual[i], e, tolerance));
  if (typeof expected === 'boolean') return op === '==' && actual === expected;
  if (typeof expected === 'string') return op === '==' && String(actual) === expected;
  if (typeof actual !== 'number') return false;
  switch (op) {
    case '<=':
      return actual <= expected + tolerance;
    case '>=':
      return actual >= expected - tolerance;
    case '<':
      return actual < expected;
    case '>':
      return actual > expected;
    default:
      return Math.abs(actual - expected) <= tolerance;
  }
}
