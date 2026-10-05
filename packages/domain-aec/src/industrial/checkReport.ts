import type { BuildingModel } from '@core/model/building';
import { round } from '../numeric';
import { toCsv } from '../scheduleBuild';

/** The first item of highest utilisation; undefined when there is none. */
export const highestUtilisation = <Item extends { utilisation: number }>(
  items: readonly Item[],
): Item | undefined =>
  items.reduce<Item | undefined>(
    (best, item) => (best === undefined || item.utilisation > best.utilisation ? item : best),
    undefined,
  );

/** The labels of the first 8 items, joined; ", …" follows when there are more. */
export const briefList = <Item>(items: readonly Item[], label: (item: Item) => string): string =>
  `${items.slice(0, 8).map(label).join(', ')}${items.length > 8 ? ', …' : ''}`;

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

/** Level a read-only check runs on: `requested`, else the active / first level; undefined when it does not exist. */
export const existingLevelId = (
  building: BuildingModel,
  requested: string | undefined,
): string | undefined => {
  const levelId = requested ?? building.activeLevelId ?? building.levelOrder[0];
  return levelId !== undefined && building.levels[levelId] ? levelId : undefined;
};
