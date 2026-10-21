/** Rule data resolution: K-factor of a bend, minimum-radius rows, and the unverified inputs a part depends on (TR-FTR-06). */

import type { DocumentUnit } from '@core/model/types';
import type { BendRadiusRow, SheetMetalModel, SheetMetalRule, Verification } from '@core/model/sheetMetal';
import type { FtrUnverifiedInput } from '@core/model/manufacturing';
import { MM_PER_UNIT } from '@core/model/units';
import { FORMULAS, dinToAnsiK, kFromTable } from './sheetMath';

export interface ResolvedK {
  /** ANSI K-factor actually used. */
  readonly value: number;
  readonly source: string;
  readonly verification: Verification;
  readonly formula: string;
}

/** ANSI K of `rule` at `insideRadius`: a bend override, a single value, or the table interpolated at r/T. */
export function resolveK(rule: SheetMetalRule, insideRadius: number, override?: number): ResolvedK {
  if (override !== undefined) return { value: override, source: 'bend override', verification: 'verified', formula: 'K_override' };
  const spec = rule.k;
  const toAnsi = (k: number): number => (spec.standard === 'din' ? dinToAnsiK(k).value : k);
  if ('table' in spec) {
    const rows = spec.table.map((row) => ({ rOverT: row.rOverT, k: toAnsi(row.k) }));
    return {
      value: kFromTable(rows, insideRadius / rule.thickness).value,
      source: `${spec.source} (rule ${rule.name} K table)`,
      verification: spec.verification,
      formula: FORMULAS.kTable,
    };
  }
  return {
    value: toAnsi(spec.value),
    source: `rule ${rule.name}`,
    verification: 'verified',
    formula: spec.standard === 'din' ? FORMULAS.kDinToAnsi : 'K_ansi',
  };
}

export interface RadiusRowMatch {
  readonly row: BendRadiusRow;
  readonly id: string;
  /** Minimum inside radius converted to the requested unit. */
  readonly minInsideRadius: number;
}

const rowUnit = (units: 'mm' | 'in'): number => (units === 'in' ? 25.4 : 1);

export const radiusRowId = (row: BendRadiusRow): string => `${row.material}/${row.temper}/${row.thickness}${row.units}/${row.bendAngle}deg`;

/** Rows with the same material, temper and thickness (within 1e-6 relative); `thicknessMm` is the thickness in millimetres. */
function rowsFor(table: readonly BendRadiusRow[], material: string, temper: string, thicknessMm: number): BendRadiusRow[] {
  return table.filter(
    (row) =>
      row.material === material &&
      row.temper === temper &&
      Math.abs(row.thickness * rowUnit(row.units) - thicknessMm) <= 1e-6 * Math.max(1, thicknessMm),
  );
}

/**
 * The radius row for a bend: same material, temper and thickness, bend angle nearest `angleDeg`.
 * @param unit unit of `thickness` and of the returned radius
 */
export function findRadiusRow(
  table: readonly BendRadiusRow[],
  query: {
    readonly material: string;
    readonly temper: string | undefined;
    readonly thickness: number;
    readonly unit: DocumentUnit;
    readonly angleDeg: number;
  },
): RadiusRowMatch | undefined {
  if (query.temper === undefined) return undefined;
  const rows = rowsFor(table, query.material, query.temper, query.thickness * MM_PER_UNIT[query.unit]);
  const best = [...rows].sort((a, b) => Math.abs(a.bendAngle - query.angleDeg) - Math.abs(b.bendAngle - query.angleDeg))[0];
  if (best === undefined) return undefined;
  return { row: best, id: radiusRowId(best), minInsideRadius: (best.minInsideRadius * rowUnit(best.units)) / MM_PER_UNIT[query.unit] };
}

/** Unverified rows, K table and thresholds a rule (and so every part built on it) depends on. */
export function ruleUnverifiedInputs(model: SheetMetalModel, rule: SheetMetalRule, unit: DocumentUnit): FtrUnverifiedInput[] {
  const inputs: FtrUnverifiedInput[] = [];
  if ('table' in rule.k && rule.k.verification === 'unverified') inputs.push({ kind: 'k_table', id: rule.name, source: rule.k.source });
  if (rule.temper !== undefined)
    for (const row of rowsFor(model.radiusTable, rule.material, rule.temper, rule.thickness * MM_PER_UNIT[unit]))
      if (row.verification === 'unverified') inputs.push({ kind: 'radius_row', id: radiusRowId(row), source: row.source });
  for (const [name, threshold] of Object.entries(rule.thresholds ?? {}))
    if (threshold.verification === 'unverified') inputs.push({ kind: 'preset', id: `${rule.name}/${name}`, source: threshold.source });
  return inputs;
}
