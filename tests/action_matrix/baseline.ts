/**
 * The ratchet (`baseline.json`): per kernel column, key `design|command|target` -> outcome. A key that was `ok` must stay `ok`; a throw or an
 * invalid solid is never baselined (a finding is quarantined in `knownErrors` with its reason until fixed, and anything not listed there fails).
 * The file carries one column per kernel, so a native-kernel column (server/tests/actionMatrix.test.ts) lives beside the Manifold one.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { KernelColumn, MatrixReport, MatrixRow, Outcome } from './types';

export const BASELINE_PATH = path.join(__dirname, 'baseline.json');

type BaselineOutcome = Exclude<Outcome, 'error'>;

interface BaselineColumn {
  /** key -> outcome (never `error`). */
  entries: Record<string, BaselineOutcome>;
  /** key -> reason of a quarantined error finding. */
  knownErrors: Record<string, string>;
}

export interface Baseline {
  version: 1;
  kernels: Partial<Record<KernelColumn, BaselineColumn>>;
}

export interface RatchetResult {
  /** Baseline `ok` keys that are not `ok` now. */
  readonly regressions: readonly string[];
  /** Baseline `ok` keys of a fully run design that were not produced at all. */
  readonly vanished: readonly string[];
  /** Keys that now succeed and were not `ok` in the baseline (or are new). */
  readonly improvements: readonly string[];
  /** Keys not in the baseline yet. */
  readonly added: readonly string[];
  /** Error rows not quarantined in `knownErrors`. */
  readonly errors: readonly MatrixRow[];
  /** Quarantined errors that no longer fail. */
  readonly fixedErrors: readonly string[];
}

export function readBaseline(file = BASELINE_PATH): Baseline {
  if (!existsSync(file)) return { version: 1, kernels: {} };
  return JSON.parse(readFileSync(file, 'utf8')) as Baseline;
}

const sortedRecord = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function writeBaseline(baseline: Baseline, file = BASELINE_PATH): void {
  const kernels: Baseline['kernels'] = {};
  for (const name of Object.keys(baseline.kernels).sort() as KernelColumn[]) {
    const column = baseline.kernels[name];
    if (column !== undefined) kernels[name] = { entries: sortedRecord(column.entries), knownErrors: sortedRecord(column.knownErrors) };
  }
  const block = (record: Record<string, string>): string => {
    const items = Object.entries(record).map(([key, value]) => `        ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
    return items.length === 0 ? '{}' : `{\n${items.join(',\n')}\n      }`;
  };
  const columns = Object.entries(kernels).map(
    ([name, column]) =>
      `    ${JSON.stringify(name)}: {\n      "entries": ${block(column.entries)},\n      "knownErrors": ${block(column.knownErrors)}\n    }`,
  );
  writeFileSync(file, `{\n  "version": 1,\n  "kernels": {\n${columns.join(',\n')}\n  }\n}\n`);
}

const columnOf = (baseline: Baseline, kernel: KernelColumn): BaselineColumn => baseline.kernels[kernel] ?? { entries: {}, knownErrors: {} };

export function ratchet(baseline: Baseline, report: MatrixReport): RatchetResult {
  const column = columnOf(baseline, report.kernel);
  const produced = new Set(report.rows.map((row) => row.key));
  const regressions: string[] = [];
  const improvements: string[] = [];
  const added: string[] = [];
  const errors: MatrixRow[] = [];
  for (const row of report.rows) {
    const before = column.entries[row.key];
    if (row.outcome === 'error') {
      if (column.knownErrors[row.key] === undefined) errors.push(row);
      if (before === 'ok') regressions.push(`${row.key}: ok -> error (${row.errorKind}: ${row.detail})`);
      continue;
    }
    if (before === undefined) added.push(row.key);
    else if (before === 'ok' && row.outcome !== 'ok') regressions.push(`${row.key}: ok -> ${row.outcome} (${row.detail})`);
    if (row.outcome === 'ok' && before !== 'ok') improvements.push(`${row.key}: ${before ?? 'new'} -> ok`);
  }
  const full = new Set(report.fullDesigns);
  const vanished = Object.entries(column.entries)
    .filter(([key, outcome]) => outcome === 'ok' && full.has(key.split('|')[0] ?? '') && !produced.has(key))
    .map(([key]) => key);
  const failing = new Set(report.rows.filter((row) => row.outcome === 'error').map((row) => row.key));
  const fixedErrors = Object.keys(column.knownErrors).filter((key) => produced.has(key) && !failing.has(key));
  return { regressions, vanished, improvements, added, errors, fixedErrors };
}

/** The baseline with `report` blessed in: the designs run completely are replaced, other keys are merged. */
export function bless(baseline: Baseline, report: MatrixReport): Baseline {
  const column = structuredClone(columnOf(baseline, report.kernel));
  const full = new Set(report.fullDesigns);
  for (const key of Object.keys(column.entries)) if (full.has(key.split('|')[0] ?? '')) delete column.entries[key];
  for (const key of Object.keys(column.knownErrors)) if (full.has(key.split('|')[0] ?? '')) delete column.knownErrors[key];
  for (const row of report.rows) {
    if (row.outcome === 'error') {
      if (row.errorKind !== 'throw') column.knownErrors[row.key] = `${row.errorKind}: ${row.detail}`;
    } else {
      column.entries[row.key] = row.outcome;
      delete column.knownErrors[row.key];
    }
  }
  return { version: 1, kernels: { ...baseline.kernels, [report.kernel]: column } };
}
