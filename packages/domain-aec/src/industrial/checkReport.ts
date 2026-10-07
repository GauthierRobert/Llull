import { round } from '../numeric';
import { toCsv } from '../csv';
import { briefList, highestUtilisation } from './utilisation';

/** Summary tail of an engineering check: `allOkText`, or up to 8 failing rows (utilisation > 1). */
export const failureSummary = <Row extends { utilisation: number }>(
  failures: readonly Row[],
  label: (row: Row) => string,
  allOkText: string,
): string =>
  failures.length === 0
    ? allOkText
    : `${failures.length} failure(s): ${briefList(failures, (row) => `${label(row)} ${round(row.utilisation)}`)}.`;

/** CSV + failing rows (utilisation > 1) + first row of maximum utilisation; `cells` receives the Status text. */
export const checkTable = <Row extends { utilisation: number }>(
  rows: readonly Row[],
  header: readonly string[],
  cells: (row: Row, status: 'FAIL' | 'OK') => (string | number)[],
): { csv: string; failures: Row[]; worst: Row | undefined } => ({
  csv: toCsv(
    header,
    rows.map((row) => cells(row, row.utilisation > 1 ? 'FAIL' : 'OK')),
  ),
  failures: rows.filter((row) => row.utilisation > 1),
  worst: highestUtilisation(rows),
});

/** Trailing columns of a value-vs-limit check table (purlins, foundations); pair with `limitCells`. */
export const LIMIT_COLUMNS = [
  'Check',
  'Value',
  'Limit',
  'Unit',
  'Utilisation',
  'Status',
  'Combination',
] as const;

/** Cells of `LIMIT_COLUMNS` for one row. */
export const limitCells = (
  row: {
    check: string;
    value: number;
    limit: number;
    unit: string;
    utilisation: number;
    combination: string;
  },
  status: 'FAIL' | 'OK',
): (string | number)[] => [
  row.check,
  round(row.value),
  round(row.limit),
  row.unit,
  round(row.utilisation),
  status,
  row.combination,
];
