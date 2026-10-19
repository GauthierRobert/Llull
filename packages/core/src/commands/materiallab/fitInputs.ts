/** Input parsing shared by the linear and non-linear branches of fit_material_model: rows, units, fixed values, refusals. */

import { convertValue, isUnitFailure } from '../../lib/quantity';
import type { HyperTest } from '../../model/materialLaws/fit';
import type { HyperMode } from '../../model/materialLaws/hyperelastic';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { matlRefusal } from '../document/materialModelRefusal';

export const FIT_COMMAND = 'fit_material_model';
const MODE_OF: Readonly<Record<string, HyperMode>> = { uniaxial: 'UT', equibiaxial: 'ET', planar: 'PS' };

export interface RawTest {
  mode: string;
  rows: number[][];
  xMeasure: string;
  yMeasure: string;
  units?: Record<string, string> | undefined;
  weight?: number | undefined;
}

export const refuse = (doc: CadDocument, code: string, message: string, path: string, remediation?: string): CommandResult => ({
  ...matlRefusal(doc, FIT_COMMAND, code, message, [], path, remediation),
  data: { code, path, remediation: remediation ?? null },
});

export const isRefusal = (value: unknown): value is CommandResult => typeof value === 'object' && value !== null && 'document' in value;

export const stressIn = (value: number, unit: string, to: string): number | null => {
  const converted = convertValue(value, unit, to);
  return isUnitFailure(converted) ? null : converted.value;
};

/** Rows of one test as [x, y] pairs, finite and 2 columns wide; the failing path as a string otherwise. */
export function pairs(test: RawTest, index: number): ReadonlyArray<readonly [number, number]> | string {
  const out: [number, number][] = [];
  for (const [j, row] of test.rows.entries()) {
    const [x, y] = row;
    if (row.length !== 2 || x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y))
      return `tests[${index}].rows[${j}]`;
    out.push([x, y]);
  }
  return out;
}

export const quantityOf = (value: unknown): { value: number; unit: string } | null => {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return typeof record['value'] === 'number' && typeof record['unit'] === 'string'
    ? { value: record['value'], unit: record['unit'] }
    : null;
};

export function hyperTests(doc: CadDocument, tests: readonly RawTest[]): HyperTest[] | CommandResult {
  const out: HyperTest[] = [];
  for (const [i, test] of tests.entries()) {
    const mode = MODE_OF[test.mode];
    if (mode === undefined)
      return refuse(
        doc,
        'MATL_LAW_PARAMS_INVALID',
        `hyperelastic fits take modes uniaxial, equibiaxial, planar, got '${test.mode}'`,
        `tests[${i}].mode`,
      );
    if (test.xMeasure !== 'stretch' || test.yMeasure !== 'nominal_stress')
      return refuse(
        doc,
        'MATL_LAW_PARAMS_INVALID',
        "hyperelastic rows are [stretch, nominal_stress]: set xMeasure 'stretch' and yMeasure 'nominal_stress'",
        `tests[${i}].yMeasure`,
      );
    const unit = test.units?.['y'];
    if (unit === undefined)
      return refuse(
        doc,
        'MATL_LAW_PARAMS_INVALID',
        "give units.y, the stress unit of the rows (e.g. 'MPa'); it is never defaulted",
        `tests[${i}].units`,
      );
    const rows = pairs(test, i);
    if (typeof rows === 'string') return refuse(doc, 'MATL_LAW_PARAMS_INVALID', 'rows must be finite [x, y] pairs', rows);
    const converted: [number, number][] = [];
    for (const [stretch, stress] of rows) {
      const mpa = stressIn(stress, unit, 'MPa');
      if (mpa === null || !(stretch > 0))
        return refuse(doc, 'MATL_LAW_PARAMS_INVALID', `stretch must be > 0 and '${unit}' a stress unit`, `tests[${i}].rows`);
      converted.push([stretch, mpa]);
    }
    if (!(test.weight === undefined || test.weight > 0))
      return refuse(doc, 'MATL_LAW_PARAMS_INVALID', 'weight must be > 0', `tests[${i}].weight`);
    out.push({ mode, rows: converted, weight: test.weight ?? 1 });
  }
  return out;
}

/** The single test of a one-test kind: its [x, y] rows with y converted to MPa (`units.y`), or a refusal. */
export function stressRows(
  doc: CadDocument,
  tests: readonly RawTest[],
  mode: string,
  label: string,
): { rows: [number, number][]; weight: number } | CommandResult {
  const test = tests[0];
  if (test === undefined || tests.length !== 1 || test.mode !== mode)
    return refuse(doc, 'MATL_LAW_PARAMS_INVALID', `${label} takes ONE test with mode '${mode}'`, 'tests');
  const unit = test.units?.['y'];
  const rows = pairs(test, 0);
  if (unit === undefined || typeof rows === 'string')
    return refuse(doc, 'MATL_LAW_PARAMS_INVALID', 'rows must be finite [x, stress] pairs with units.y (a stress unit)', 'tests[0]');
  const out: [number, number][] = [];
  for (const [x, stress] of rows) {
    const mpa = stressIn(stress, unit, 'MPa');
    if (mpa === null) return refuse(doc, 'MATL_LAW_PARAMS_INVALID', `'${unit}' is not a stress unit`, 'tests[0].units');
    out.push([x, mpa]);
  }
  return { rows: out, weight: test.weight ?? 1 };
}

/** A fixed stress {value, unit} of `fixed[key]` in MPa, or a refusal. */
export function fixedStress(doc: CadDocument, fixed: Record<string, unknown> | undefined, key: string): number | CommandResult {
  const quantity = quantityOf(fixed?.[key]);
  const mpa = quantity === null ? null : stressIn(quantity.value, quantity.unit, 'MPa');
  return mpa === null && quantity !== null
    ? refuse(doc, 'MATL_LAW_PARAMS_INVALID', `fixed.${key} '${quantity.unit}' is not a stress unit`, `fixed.${key}`)
    : mpa === null
      ? refuse(doc, 'MATL_LAW_PARAMS_INVALID', `give fixed.${key} as {value, unit}`, 'fixed')
      : mpa;
}
