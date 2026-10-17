/** Temperature table import (PHY-04 TR-TMC-14): CSV text `x,y,z,T` with declared units -> the `fe_table` artifact a `table` field source reads. */

import type { FeTableArtifact } from '@core/model/analysis';
import { MAX_PLAUSIBLE_TEMPERATURE } from '../shared/quantity';
import { affineBetween, metresPer } from './units';

/** Named guard: the most rows a table may have ("llull guard"; a larger table is a mistake or an attack). */
export const MAX_TABLE_ROWS = { value: 5_000_000, source: 'llull guard' } as const;

export type TableImport =
  | { readonly ok: true; readonly artifact: FeTableArtifact; readonly rows: number; readonly minT: number; readonly maxT: number }
  | { readonly ok: false; readonly code: string; readonly message: string };

const fail = (code: string, message: string): TableImport => ({ ok: false, code, message });

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** Cells of a line: split at commas, semicolons or tabs when present, else at whitespace. */
const cellsOf = (line: string): string[] =>
  (/[,;\t]/.test(line) ? line.split(/[,;\t]/) : line.split(/\s+/))
    .map((cell) => cell.trim())
    .filter((cell, i, all) => cell !== '' || i < all.length - 1);

/**
 * Parse a CSV of node coordinates and temperatures: one row per line `x,y,z,T` (commas, semicolons, tabs or spaces), an optional first
 * line `x,y,z,T` naming the columns, blank lines and `#` comments ignored. Coordinates are in `coordinatesUnit`, T in `temperatureUnit`
 * (`degC`, `K`, `degF`); the artifact keeps them as given and the `table` field source converts at deck time.
 * @failure invalid units / no rows / too many rows -> TMC_FIELD_SOURCE_INVALID; a malformed line, a non-finite value or a temperature
 *   outside [0, 1e5] K (named guard) -> TMC_FIELD_INVALID with the line number
 */
export function parseFieldTable(csv: string, coordinatesUnit: string, temperatureUnit: string): TableImport {
  if (metresPer(coordinatesUnit) === null)
    return fail('TMC_FIELD_SOURCE_INVALID', `coordinatesUnit '${coordinatesUnit}' is not a length unit`);
  const toKelvin = affineBetween(temperatureUnit, 'K');
  if (toKelvin === null)
    return fail('TMC_FIELD_SOURCE_INVALID', `temperatureUnit '${temperatureUnit}' is not a temperature unit (degC, K, degF)`);
  const rows: [number, number, number, number][] = [];
  let minT = Number.POSITIVE_INFINITY;
  let maxT = Number.NEGATIVE_INFINITY;
  const lines = csv.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const cells = cellsOf(line);
    const at = `line ${index + 1}`;
    if (rows.length === 0 && cells.length >= 4 && !NUMBER.test(cells[0] ?? '')) {
      const names = cells.slice(0, 3).map((cell) => cell.toLowerCase());
      if (names.join() !== 'x,y,z')
        return fail('TMC_FIELD_INVALID', `${at}: the header must name the columns x,y,z,T, got '${line.slice(0, 80)}'`);
      continue;
    }
    if (cells.length !== 4) return fail('TMC_FIELD_INVALID', `${at}: expected 4 columns x,y,z,T, got ${cells.length}`);
    if (!cells.every((cell) => NUMBER.test(cell)))
      return fail('TMC_FIELD_INVALID', `${at}: a value is not a number ('${line.slice(0, 80)}')`);
    const [x = 0, y = 0, z = 0, t = 0] = cells.map(Number);
    if (![x, y, z, t].every(Number.isFinite)) return fail('TMC_FIELD_INVALID', `${at}: a value is not finite`);
    const kelvin = toKelvin.offset + toKelvin.scale * t;
    if (kelvin < 0 || kelvin > MAX_PLAUSIBLE_TEMPERATURE.value)
      return fail(
        'TMC_FIELD_INVALID',
        `${at}: temperature ${t} ${temperatureUnit} is outside [0, ${MAX_PLAUSIBLE_TEMPERATURE.value}] K (${MAX_PLAUSIBLE_TEMPERATURE.source})`,
      );
    if (rows.length >= MAX_TABLE_ROWS.value)
      return fail('TMC_FIELD_SOURCE_INVALID', `more than ${MAX_TABLE_ROWS.value} rows (${MAX_TABLE_ROWS.source})`);
    rows.push([x, y, z, t]);
    minT = Math.min(minT, t);
    maxT = Math.max(maxT, t);
  }
  if (rows.length === 0) return fail('TMC_FIELD_SOURCE_INVALID', 'the table has no rows (expected lines x,y,z,T)');
  return { ok: true, artifact: { kind: 'fe_table', rows }, rows: rows.length, minT, maxT };
}
