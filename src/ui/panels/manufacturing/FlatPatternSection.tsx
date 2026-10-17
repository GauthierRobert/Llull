// Flat-pattern toggle (07 §7.3): shows the analytic flat pattern of a sheet-metal part from the read-only `flat_pattern` query, with the
// bend table, a provenance popover and the review banner. Drawing it into the document and the DXF are commands (materialize / export).

import React, { useMemo } from 'react';
import { PanelSection } from '@ui/panels/PanelParts';
import { ProvenancePopover } from '@ui/panels/ProvenancePopover';
import { ReviewBanner } from '@ui/panels/ReviewBanner';
import { useReadOnlyQuery } from '@ui/panels/useReadOnlyQuery';
import { downloadQuery } from '@ui/services/localQuery';
import { significantNumber } from '@lib/compactNumber';
import { useStore } from '@ui/store';
import { parseFlatPattern, type FlatPatternView } from './ftrData';

const SVG_SIZE = 160;
const fmt = (value: number): string => significantNumber(value, 5);

function OutlinePreview({ view }: { view: FlatPatternView }): React.ReactElement | null {
  const path = useMemo(() => {
    if (view.outline.length < 3) return null;
    const [width, height] = view.extents;
    const scale = (SVG_SIZE - 8) / Math.max(width, height, 1e-9);
    const points = view.outline.map(([x, y]) => `${(4 + x * scale).toFixed(2)},${(SVG_SIZE - 4 - y * scale).toFixed(2)}`);
    return `M${points.join('L')}Z`;
  }, [view]);
  if (path === null) return null;
  return (
    <svg
      className="flat-preview"
      viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
      role="img"
      aria-label="Flat pattern outline"
      data-testid="flat-outline"
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function FlatPatternSection({ partId }: { partId: string }): React.ReactElement {
  const flat = useReadOnlyQuery('flat_pattern', parseFlatPattern);
  const dispatch = useStore((s) => s.dispatch);
  const shown = flat.view !== null;
  const toggle = (): void => (shown ? flat.clear() : flat.run({ id: partId }));
  const view = flat.view;
  return (
    <PanelSection title="Flat pattern" testId="mfg-flat">
      <div className="mfg__actions">
        <button type="button" className="btn btn--sm" aria-pressed={shown} onClick={toggle} data-testid="flat-toggle">
          {shown ? 'Hide flat pattern' : 'Show flat pattern'}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => dispatch('materialize_flat_pattern', { id: partId })}
          data-testid="flat-materialize"
          title="Draw the flat pattern as 2D entities"
        >
          Draw as 2D
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => downloadQuery('export_flat_pattern_dxf', { id: partId }, 'dxf', `${partId}-flat.dxf`, 'application/dxf')}
          data-testid="flat-dxf"
        >
          Export DXF
        </button>
      </div>
      {view === null ? (
        flat.summary !== '' && (
          <p className="panel__row-meta" role="status" data-testid="flat-refusal">
            {flat.summary}
          </p>
        )
      ) : (
        <div data-testid="flat-result">
          {flat.stale && (
            <p className="review-panel__stale" role="status">
              <span aria-hidden="true">◌</span> The model changed. Toggle again to refresh.
            </p>
          )}
          <ReviewBanner {...(view.reviewReason === undefined ? {} : { reason: view.reviewReason })} unverified={view.unverified} />
          <OutlinePreview view={view} />
          <p className="mfg__figures" data-testid="flat-figures">
            {fmt(view.extents[0])} × {fmt(view.extents[1])} {view.unit} · area {fmt(view.area)} · {view.bends.length} bend(s)
          </p>
          {view.bends.length > 0 && (
            <table className="mfg__table" data-testid="flat-bends">
              <thead>
                <tr>
                  <th scope="col">Bend</th>
                  <th scope="col">Angle°</th>
                  <th scope="col">R</th>
                  <th scope="col">Dir</th>
                  <th scope="col">BA</th>
                  <th scope="col">K</th>
                </tr>
              </thead>
              <tbody>
                {view.bends.map((bend) => (
                  <tr key={bend.id}>
                    <th scope="row">{bend.id}</th>
                    <td>{bend.angleDeg}</td>
                    <td>{bend.insideRadius}</td>
                    <td>{bend.direction}</td>
                    <td>{fmt(bend.ba)}</td>
                    <td title={bend.kSource}>{bend.k}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ProvenancePopover entries={view.provenance} testId="flat-provenance" />
        </div>
      )}
    </PanelSection>
  );
}
