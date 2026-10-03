import { round } from '../numeric';

/** Summary tail of an engineering check: `allOkText`, or up to 8 failing rows (utilisation > 1). */
export const failureSummary = <Row extends { utilisation: number }>(
  failures: readonly Row[],
  label: (row: Row) => string,
  allOkText: string,
): string =>
  failures.length === 0
    ? allOkText
    : `${failures.length} failure(s): ${failures
        .slice(0, 8)
        .map((row) => `${label(row)} ${round(row.utilisation)}`)
        .join(', ')}${failures.length > 8 ? ', …' : ''}.`;
