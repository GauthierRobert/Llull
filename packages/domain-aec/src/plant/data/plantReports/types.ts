/** Shared shapes of the plant reports (plant 08 DAT §5.9): typed columns with units, rows keyed by column name, a pure result. */

import type { PlantValue } from '../model';

export const REPORT_KINDS = [
  'line_list',
  'equipment_list',
  'nozzle_schedule',
  'valve_list',
  'instrument_index',
  'mto',
  'tag_register',
  'custom',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export interface ReportColumn {
  readonly name: string;
  readonly displayName: string;
  /** A property type (`text`, `pressure`, ...) or `integer` / `real` / `boolean` / `text` for derived columns. */
  readonly type: string;
  readonly unit: string | null;
  readonly readOnly: boolean;
  /** `property` (a stored value), `geometry` (read from the model object), `derived` (computed from several facts). */
  readonly source: 'property' | 'geometry' | 'derived';
}

export type ReportRow = Readonly<Record<string, PlantValue>>;

export interface ReportTable {
  readonly columns: readonly ReportColumn[];
  readonly rows: readonly ReportRow[];
  /** Column whose value identifies a row (`rowsByTag`), null when no column does. */
  readonly keyColumn: string | null;
  /** How quantities were measured: `centreline` (stored polylines), `cutLength` (routed runs: cut lengths with the take-outs of the catalogue, parts counted), `mixed` (both in one table), `inferred` (nozzles from line ends), `model` (nozzles read from 03 EQP), `none`. */
  readonly method: 'centreline' | 'cutLength' | 'mixed' | 'inferred' | 'model' | 'none';
  readonly totals: Readonly<Record<string, number>>;
  /** Defaults the report applied that the caller did not choose (AF-31). */
  readonly defaults: Readonly<Record<string, string>>;
}

export type ReportOutcome =
  | { readonly ok: true; readonly table: ReportTable }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly path: string };

export const columnOf = (
  name: string,
  displayName: string,
  type: string,
  unit: string | null,
  source: ReportColumn['source'],
): ReportColumn => ({ name, displayName, type, unit, readOnly: true, source });

/** `Name (unit)`: the header text of a column in CSV and XLSX. */
export const headerOf = (column: ReportColumn): string =>
  column.unit === null ? column.displayName : `${column.displayName} (${column.unit})`;

/** Rounds to 1e-6 (a micrometre of a length in metres) so sums of exact legs print cleanly. */
export const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
