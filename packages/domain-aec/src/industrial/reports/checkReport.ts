import { round } from '../../shared/numeric';
import { toCsv } from '@lib/csv';
import { briefList } from '../../shared/briefList';
import { failingRows, highestUtilisation, refusedRows, type UtilisationRow } from '../common/utilisation';

/** Status cell of a check row: REFUSED when its input was refused (not computed), else FAIL (> 1) or OK. */
export type CheckStatus = 'FAIL' | 'OK' | 'REFUSED';

/** The refused rows as `data.refused` entries (the row's element id and label, the refusal code and message). */
export const refusedEntries = <Row extends UtilisationRow & { elementId: string }>(
  rows: readonly Row[],
  label: (row: Row) => string,
): { elementId: string; label: string; code: string; message: string }[] =>
  refusedRows(rows).flatMap((row) =>
    row.refusal ? [{ elementId: row.elementId, label: label(row), code: row.refusal.code, message: row.refusal.message }] : [],
  );

/** "n refused (CODE[, CODE]): a, b" for the refused rows; empty when there are none. */
export const refusedText = <Row extends UtilisationRow>(refused: readonly Row[], label: (row: Row) => string): string =>
  refused.length === 0
    ? ''
    : `${refused.length} refused (${[...new Set(refused.map((row) => row.refusal?.code))].join(', ')}): ${briefList(refused, label)}`;

/**
 * Summary tail of an engineering check: `allOkText` when nothing failed and nothing was refused, up to 8 failing rows (utilisation > 1),
 * and the refused rows (input refused, not computed): a check with a refused row is never "all OK".
 */
export const failureSummary = <Row extends UtilisationRow>(
  failures: readonly Row[],
  label: (row: Row) => string,
  allOkText: string,
  refused: readonly Row[] = [],
): string => {
  const failed = failures.length === 0 ? '' : `${failures.length} failure(s): ${briefList(failures, (row) => `${label(row)} ${round(row.utilisation)}`)}.`;
  const unchecked = refusedText(refused, label);
  if (failed === '' && unchecked === '') return allOkText;
  return [failed, unchecked === '' ? '' : `${unchecked}.`].filter((part) => part !== '').join(' ');
};

/** CSV + failing rows (utilisation > 1) + refused rows + first computed row of maximum utilisation; `cells` receives the Status text. */
export const checkTable = <Row extends UtilisationRow>(
  rows: readonly Row[],
  header: readonly string[],
  cells: (row: Row, status: CheckStatus) => (string | number)[],
): { csv: string; failures: Row[]; refused: Row[]; worst: Row | undefined } => ({
  csv: toCsv(
    header,
    rows.map((row) => cells(row, row.refusal !== undefined ? 'REFUSED' : row.utilisation > 1 ? 'FAIL' : 'OK')),
  ),
  failures: failingRows(rows),
  refused: refusedRows(rows),
  worst: highestUtilisation(rows),
});

/** Trailing columns of a value-vs-limit check table (purlins, foundations); pair with `limitCells`. */
export const LIMIT_COLUMNS = ['Check', 'Value', 'Limit', 'Unit', 'Utilisation', 'Status', 'Combination'] as const;

/** Cells of `LIMIT_COLUMNS` for one row; a refused row shows its code in the Utilisation cell. */
export const limitCells = (
  row: { check: string; value: number; limit: number; unit: string; utilisation: number; combination: string; refusal?: { code: string } },
  status: CheckStatus,
): (string | number)[] => [
  row.check,
  round(row.value),
  round(row.limit),
  row.unit,
  row.refusal ? `refused (${row.refusal.code})` : round(row.utilisation),
  status,
  row.combination,
];
