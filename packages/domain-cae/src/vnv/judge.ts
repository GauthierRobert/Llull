/** Pure benchmark judge (PHY-00 TECHNICAL_SPEC §5.3): one measured value against one `expected_results.json` case. */

import { convertValue, isUnitFailure, parseUnit } from '@lib/quantity';
import { expectedCaseSchema, normaliseGrade, type ExpectedCase, type JsonValue } from './expected';

export type Verdict = 'pass' | 'fail' | 'warn' | 'skip' | 'error';

export interface Measured {
  readonly value: JsonValue;
  readonly unit: string;
}

export interface Judgement {
  readonly verdict: Verdict;
  readonly code?: string;
  readonly grade?: string;
  readonly relError?: number;
  readonly absError?: number;
  readonly convertedValue?: JsonValue;
  readonly unit?: string;
  readonly message: string;
  readonly path?: string;
  readonly remediation?: string;
}

interface Tolerance {
  readonly rel?: number | null | undefined;
  readonly abs?: number | null | undefined;
  readonly exact?: boolean | undefined;
}

const isRecord = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numberMatches = (measured: number, expected: number, tolerance: Tolerance): boolean => {
  const diff = Math.abs(measured - expected);
  const { rel, abs, exact } = tolerance;
  if (exact === true || ((rel ?? null) === null && (abs ?? null) === null)) return measured === expected;
  return (abs !== null && abs !== undefined && diff <= abs) || (rel !== null && rel !== undefined && diff <= rel * Math.abs(expected));
};

/** Leaf-wise comparison: numbers by tolerance, strings / booleans / null exactly, lists element-wise, records key-wise. */
export function valuesMatch(measured: JsonValue, expected: JsonValue, tolerance: Tolerance): boolean {
  if (typeof expected === 'number') return typeof measured === 'number' && numberMatches(measured, expected, tolerance);
  if (Array.isArray(expected)) {
    return (
      Array.isArray(measured) &&
      measured.length === expected.length &&
      expected.every((e, i) => valuesMatch(measured[i] ?? null, e, tolerance))
    );
  }
  if (isRecord(expected)) {
    if (!isRecord(measured)) return false;
    const keys = Object.keys(expected);
    return (
      keys.length === Object.keys(measured).length &&
      keys.every((k) => k in measured && valuesMatch(measured[k] ?? null, expected[k] ?? null, tolerance))
    );
  }
  return measured === expected;
}

/** `measured` holds every field listed by the contract with deep-equal values (extra measured fields are allowed). */
const contractHolds = (measured: JsonValue, contract: JsonValue): boolean => {
  if (isRecord(contract)) {
    return isRecord(measured) && Object.entries(contract).every(([k, v]) => k in measured && contractHolds(measured[k] ?? null, v));
  }
  return valuesMatch(measured, contract, { exact: true });
};

const convertLeaves = (value: JsonValue, from: string, to: string): JsonValue => {
  if (typeof value === 'number') {
    const converted = convertValue(value, from, to);
    return isUnitFailure(converted) ? value : converted.value;
  }
  if (Array.isArray(value)) return value.map((v) => convertLeaves(v, from, to));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convertLeaves(v, from, to)]));
  return value;
};

const onlyNullBounds = (tolerance: Tolerance): boolean =>
  tolerance.exact !== true &&
  ('rel' in tolerance || 'abs' in tolerance) &&
  (tolerance.rel ?? null) === null &&
  (tolerance.abs ?? null) === null;

const outcome = (grade: string, ok: boolean, message: string, extra: Partial<Judgement>): Judgement => {
  if (ok) return { verdict: 'pass', grade, message, ...extra };
  return grade === 'A'
    ? { verdict: 'fail', code: 'VNV_BENCHMARK_FAILED', grade, message, ...extra }
    : { verdict: 'warn', code: 'VNV_BENCHMARK_UNCONFIRMED', grade, message, ...extra };
};

/**
 * Judge one case. Grade A -> pass / fail; B -> pass / warn; C or TBD (or value `TBD`, or only null bounds) -> skip.
 * @failure malformed case -> error `VNV_EXPECTED_INVALID`; measured absent -> `VNV_RESULT_MISSING`; dimensions differ ->
 *   `VNV_UNIT_MISMATCH`
 */
export function judgeCase(rawExpected: unknown, measured: Measured | null): Judgement {
  const parsed = expectedCaseSchema.safeParse(rawExpected);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join('.') ?? '';
    return {
      verdict: 'error',
      code: 'VNV_EXPECTED_INVALID',
      message: `expected case does not match the schema at '${path}'`,
      path: `expected.${path}`,
      remediation: 'fix the pack file (docs/physics/README.md §6.3)',
    };
  }
  const expected: ExpectedCase = parsed.data;
  const grade = normaliseGrade(expected.grade);
  if (grade === null) {
    return {
      verdict: 'error',
      code: 'VNV_EXPECTED_INVALID',
      message: `unknown grade '${expected.grade}'`,
      path: 'expected.grade',
      remediation: 'grade A, B, C or TBD',
    };
  }
  if (grade === 'C' || grade === 'TBD' || expected.value === 'TBD' || onlyNullBounds(expected.tolerance)) {
    return { verdict: 'skip', code: 'VNV_EXPECTED_TBD', grade, message: `${expected.id}: expected value is TBD / grade ${grade}` };
  }
  if (expected.value === null && expected.expected === undefined) {
    return {
      verdict: 'error',
      code: 'VNV_EXPECTED_INVALID',
      grade,
      message: `${expected.id}: value null needs an 'expected' contract`,
      path: 'expected.expected',
      remediation: 'add the expected contract',
    };
  }
  if (measured === null) {
    return {
      verdict: 'error',
      code: 'VNV_RESULT_MISSING',
      grade,
      message: `${expected.id}: no measured value`,
      path: 'measured',
      remediation: 'check the harness pointer',
    };
  }
  if (expected.value === null) {
    const ok = contractHolds(measured.value, expected.expected ?? null);
    return outcome(grade, ok, `${expected.id}: contract ${ok ? 'holds' : 'violated'}`, {});
  }
  const target = parseUnit(expected.unit);
  let value = measured.value;
  if (!isUnitFailure(target) && measured.unit !== expected.unit) {
    const source = parseUnit(measured.unit);
    const probe = isUnitFailure(source) ? source : convertValue(1, measured.unit, expected.unit);
    if (isUnitFailure(probe)) {
      return {
        verdict: 'error',
        code: 'VNV_UNIT_MISMATCH',
        grade,
        message: `${expected.id}: measured unit '${measured.unit}' cannot be compared with '${expected.unit}'`,
        path: 'measured.unit',
        remediation: 'fix the extraction unit',
      };
    }
    value = convertLeaves(value, measured.unit, expected.unit);
  }
  const ok = valuesMatch(value, expected.value, expected.tolerance);
  const scalar = typeof value === 'number' && typeof expected.value === 'number' ? { m: value, v: expected.value } : null;
  const errors =
    scalar === null
      ? {}
      : {
          absError: Math.abs(scalar.m - scalar.v),
          ...(scalar.v !== 0 ? { relError: Math.abs(scalar.m - scalar.v) / Math.abs(scalar.v) } : {}),
        };
  return outcome(grade, ok, `${expected.id}: measured ${JSON.stringify(value)} ${expected.unit} vs ${JSON.stringify(expected.value)}`, {
    convertedValue: value,
    unit: expected.unit,
    ...errors,
  });
}
