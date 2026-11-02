/**
 * Pressure-temperature ratings (TR-PSC-07, §5.4): rows sorted by temperature per class; the first row covers T_min..T_1, between rows the
 * rating is linearly interpolated (permitted by B16.5 [S7]); outside the table is a refusal. Bar gauge internally.
 * @invariant interpolation only inside the table; the result is `verified` only when every row it used is
 */

import type { CadDocument } from '@core/model/types';
import { BUNDLED_RATING_TABLE_ID, bundledRatingTable } from './bundled';
import { importedRatingTable, importedRatingTables } from './store';
import type { RatingRow, RatingTable } from './types';

/** 1 psi in bar (the B16.5 bar and psi tables are separately rounded, so conversions are stated, never compared to tabulated values). */
export const BAR_PER_PSI = 0.0689475729;

export interface RatingAnswer {
  readonly ratingBar: number;
  readonly method: 'tabulated' | 'first band' | 'interpolated';
  readonly bracket: readonly RatingRow[];
  readonly verified: boolean;
}

export type RatingOutcome =
  | ({ readonly ok: true } & RatingAnswer)
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Rating (bar) of `ratingClass` at `temperatureC` from `table`. */
export function ratingAt(table: RatingTable, ratingClass: number, temperatureC: number): RatingOutcome {
  const rows = table.rows.filter((row) => row.ratingClass === ratingClass).sort((a, b) => a.temperatureC - b.temperatureC);
  const first = rows[0];
  const last = rows.at(-1);
  if (first === undefined || last === undefined)
    return {
      ok: false,
      code: 'PSC_CATALOG_ROW_MISSING',
      message: `rating table ${table.id} has no class ${ratingClass} (classes: ${[...new Set(table.rows.map((row) => row.ratingClass))].join(', ')})`,
    };
  if (temperatureC < table.minTemperatureC || temperatureC > last.temperatureC)
    return {
      ok: false,
      code: 'PSC_PT_TEMPERATURE_OUT_OF_TABLE',
      message: `${temperatureC} degC is outside the class ${ratingClass} range ${table.minTemperatureC}..${last.temperatureC} degC of ${table.id}`,
    };
  if (temperatureC <= first.temperatureC)
    return {
      ok: true,
      ratingBar: first.bar.value,
      method: temperatureC === first.temperatureC ? 'tabulated' : 'first band',
      bracket: [first],
      verified: first.bar.verified,
    };
  const upperIndex = rows.findIndex((row) => row.temperatureC >= temperatureC);
  const upper = rows[upperIndex] as RatingRow;
  const lower = rows[upperIndex - 1] as RatingRow;
  if (upper.temperatureC === temperatureC)
    return { ok: true, ratingBar: upper.bar.value, method: 'tabulated', bracket: [upper], verified: upper.bar.verified };
  const fraction = (temperatureC - lower.temperatureC) / (upper.temperatureC - lower.temperatureC);
  return {
    ok: true,
    ratingBar: lower.bar.value + (upper.bar.value - lower.bar.value) * fraction,
    method: 'interpolated',
    bracket: [lower, upper],
    verified: lower.bar.verified && upper.bar.verified,
  };
}

const sameText = (a: string, b: string): boolean => a.toLowerCase().replace(/s+/g, '') === b.toLowerCase().replace(/s+/g, '');

/** Rating tables the document can use: the bundled one first, then the imported ones in id order. */
export const allRatingTables = (doc: Pick<CadDocument, 'plant'>): readonly RatingTable[] => [
  bundledRatingTable(),
  ...importedRatingTables(doc),
];

/** The rating table of a standard and material group (case and spacing ignored; bundled first, then imported), or undefined. */
export function findRatingTable(doc: Pick<CadDocument, 'plant'>, standard: string, materialGroup: string): RatingTable | undefined {
  return allRatingTables(doc).find((table) => sameText(table.standard, standard) && sameText(table.materialGroup, materialGroup));
}

/** The rating table with this id (bundled or imported), or undefined. */
export const ratingTableById = (doc: Pick<CadDocument, 'plant'>, id: string): RatingTable | undefined =>
  id === BUNDLED_RATING_TABLE_ID ? bundledRatingTable() : importedRatingTable(doc, id);

export const availableRatingTables = (doc: Pick<CadDocument, 'plant'>): readonly string[] => allRatingTables(doc).map((table) => table.id);

/** Tabulated psig of the class at or below 100 degF (-20..100 degF band), or null when the table has no imperial row for it. */
export function tabulatedPsi(
  table: RatingTable,
  ratingClass: number,
  temperatureC: number,
): { readonly psi: number; readonly verified: boolean } | null {
  const row = table.imperialRows?.find((candidate) => candidate.ratingClass === ratingClass);
  return row !== undefined && (temperatureC * 9) / 5 + 32 <= row.temperatureF + 1e-9 && temperatureC >= table.minTemperatureC
    ? { psi: row.psi, verified: row.verified }
    : null;
}
