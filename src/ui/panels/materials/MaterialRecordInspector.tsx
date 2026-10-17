// Record inspector (08 §7): identification, badges and the property table of one material from the read-only `get_material` query,
// filterable by basis and direction, each value with a provenance popover and an unverified marker.

import React, { useEffect, useState } from 'react';
import { PanelSection } from '@ui/panels/PanelParts';
import { ProvenancePopover } from '@ui/panels/ProvenancePopover';
import { useReadOnlyQuery } from '@ui/panels/useReadOnlyQuery';
import { useStore } from '@ui/store';
import { distinct, filterValues, isControlled, licenceText, markingText, parseMaterialRecord } from './materialRecordView';

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <label className="findings__filter">
      <span className="panel__row-meta">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} data-testid={`record-filter-${label.toLowerCase()}`}>
        <option value="all">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

export function MaterialRecordInspector({ materialName }: { materialName: string }): React.ReactElement | null {
  const material = useStore((s) => s.document.materials[materialName]);
  const query = useReadOnlyQuery('get_material', parseMaterialRecord);
  const { run } = query;
  const [filter, setFilter] = useState({ basis: 'all', direction: 'all' });
  useEffect(() => run({ material: materialName }), [run, materialName]);
  if (material === undefined) return null;
  const record = material.record;
  const view = query.view;
  const shown = view === null ? [] : filterValues(view.values, filter);
  return (
    <PanelSection title={`Record: ${record?.designation ?? materialName}`} testId="material-inspector">
      {record !== undefined && (
        <div className="material-library__badges">
          {record.temper !== undefined && <span className="badge">{record.temper}</span>}
          {record.productForm !== undefined && <span className="badge">{record.productForm}</span>}
          <span className="badge" data-testid="record-licence">
            {licenceText(record.licence)}
          </span>
          <span className={`badge${isControlled(record.exportMarking) ? ' badge--danger' : ''}`} data-testid="record-marking">
            {markingText(record.exportMarking)}
          </span>
          {record.superseded !== undefined && (
            <span className="badge badge--warn" title={record.superseded.note}>
              Superseded by {record.superseded.by}
            </span>
          )}
        </div>
      )}
      {record?.specs.map((spec) => (
        <p key={`${spec.body}-${spec.id}`} className="panel__row-meta">
          {spec.body} {spec.id}
          {spec.revision === undefined ? '' : ` rev ${spec.revision}`}
        </p>
      ))}
      {view === null ? (
        <p className="panel__row-meta" role="status">
          {query.summary}
        </p>
      ) : (
        <>
          {view.unresolved !== null && (
            <p className="review-panel__stale" role="status" data-testid="record-unresolved">
              No values on this machine ({view.unresolved}).
            </p>
          )}
          <p className="mfg__figures" data-testid="record-density">
            Density used for mass: {view.densityLine}
          </p>
          <div className="findings__controls">
            <FilterSelect
              label="Basis"
              value={filter.basis}
              options={distinct(view.values, 'basis')}
              onChange={(basis) => setFilter((f) => ({ ...f, basis }))}
            />
            <FilterSelect
              label="Direction"
              value={filter.direction}
              options={distinct(view.values, 'direction')}
              onChange={(direction) => setFilter((f) => ({ ...f, direction }))}
            />
          </div>
          {shown.length === 0 ? (
            <p className="panel__row-meta" data-testid="record-no-values">
              No values match.
            </p>
          ) : (
            <table className="mfg__table" data-testid="record-values">
              <thead>
                <tr>
                  <th scope="col">Property</th>
                  <th scope="col">Value</th>
                  <th scope="col">Basis</th>
                  <th scope="col">Dir</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.id} data-testid={`record-value-${row.id}`}>
                    <th scope="row">
                      {row.property}
                      {row.preferred && <span title="Preferred value"> ★</span>}
                    </th>
                    <td>
                      {row.value} {row.unit}
                      {row.unverified && <span className="finding__badge">unverified</span>}
                    </td>
                    <td>{row.basis}</td>
                    <td>{row.direction}</td>
                    <td>
                      <ProvenancePopover title="Source" entries={row.provenance} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </PanelSection>
  );
}
