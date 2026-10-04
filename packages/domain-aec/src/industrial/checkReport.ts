import type { BuildingModel } from '@core/model/building';
import { round } from '../numeric';
import { toCsv } from '../scheduleBuild';

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
  worst: rows.reduce<Row | undefined>(
    (best, row) => (best === undefined || row.utilisation > best.utilisation ? row : best),
    undefined,
  ),
});

/** Level a read-only check runs on: `requested`, else the active / first level; undefined when it does not exist. */
export const existingLevelId = (
  building: BuildingModel,
  requested: string | undefined,
): string | undefined => {
  const levelId = requested ?? building.activeLevelId ?? building.levelOrder[0];
  return levelId !== undefined && building.levels[levelId] ? levelId : undefined;
};
