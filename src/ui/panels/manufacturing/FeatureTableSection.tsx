// Feature table (07 §7.3): the holes of a part from the read-only `hole_table` query, sortable by any column.

import React, { useState } from 'react';
import { PanelSection } from '@ui/panels/PanelParts';
import { useReadOnlyQuery } from '@ui/panels/useReadOnlyQuery';
import { parseHoleRows, sortHoleRows, type HoleSortKey } from './ftrData';

const COLUMNS: ReadonlyArray<readonly [HoleSortKey, string]> = [
  ['label', 'Hole'],
  ['x', 'X'],
  ['y', 'Y'],
  ['kind', 'Kind'],
  ['diameter', 'Ø'],
  ['depth', 'Depth'],
];

export function FeatureTableSection({ partId }: { partId: string }): React.ReactElement {
  const table = useReadOnlyQuery('hole_table', parseHoleRows);
  const [sort, setSort] = useState<{ key: HoleSortKey; ascending: boolean }>({ key: 'label', ascending: true });
  const rows = table.view === null ? null : sortHoleRows(table.view, sort.key, sort.ascending);
  const onSort = (key: HoleSortKey): void => setSort((s) => ({ key, ascending: s.key === key ? !s.ascending : true }));
  return (
    <PanelSection title="Feature table" {...(rows === null ? {} : { count: rows.length })} testId="mfg-features">
      <div className="mfg__actions">
        <button type="button" className="btn btn--sm" onClick={() => table.run({ id: partId })} data-testid="features-run">
          {rows === null ? 'List holes' : 'Refresh'}
        </button>
      </div>
      {rows === null ? (
        table.summary !== '' && (
          <p className="panel__row-meta" role="status" data-testid="features-status">
            {table.summary}
          </p>
        )
      ) : rows.length === 0 ? (
        <p className="panel__row-meta" data-testid="features-empty">
          No holes on this part.
        </p>
      ) : (
        <table className="mfg__table" data-testid="features-table">
          <thead>
            <tr>
              {COLUMNS.map(([key, label]) => (
                <th key={key} scope="col" aria-sort={sort.key === key ? (sort.ascending ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="mfg__sort" onClick={() => onSort(key)} data-testid={`features-sort-${key}`}>
                    {label}
                    {sort.key === key && <span aria-hidden="true">{sort.ascending ? ' ↑' : ' ↓'}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} data-testid={`feature-row-${row.label}`}>
                <th scope="row">{row.label}</th>
                <td>{row.x}</td>
                <td>{row.y}</td>
                <td>{row.cskAngleDeg === undefined ? row.kind : `${row.kind} ${row.cskAngleDeg}°`}</td>
                <td>{row.diameter}</td>
                <td>{row.depth}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PanelSection>
  );
}
