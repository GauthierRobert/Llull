// Review of a solved study: check_topology items (codes + remediation) and the suggest_rebuild loops preview. Both are read-only queries.

import React, { useMemo, useState } from 'react';
import type { TopologyStudy } from '@core/model/topology';
import { useStore } from '@ui/store';
import { PanelSection, StatusChip, StatusLine } from '@ui/panels/PanelParts';
import { useHostQuery } from './useHostQuery';
import { loopPath, loopsViewBox, parseRebuild, parseTopologyCheck } from './topologyData';

const PLANES = ['XY', 'XZ', 'YZ'] as const;

function RebuildPreview({ study }: { study: TopologyStudy }): React.ReactElement {
  const document = useStore((s) => s.document);
  const [plane, setPlane] = useState<(typeof PLANES)[number]>('XY');
  const params = useMemo(() => ({ studyId: study.id, ...(study.dimension === 3 ? { plane } : {}) }), [study.id, study.dimension, plane]);
  const answer = useHostQuery('suggest_rebuild', params, document);
  const view = answer.status === 'done' && !answer.isError ? parseRebuild(answer.data) : null;
  const box = view === null ? null : loopsViewBox(view.loops);
  return (
    <div data-testid="topology-rebuild">
      {study.dimension === 3 && (
        <label className="field">
          <span className="field__label">Section plane</span>
          <select
            aria-label="Section plane"
            value={plane}
            onChange={(e) => setPlane(PLANES.find((candidate) => candidate === e.target.value) ?? 'XY')}
          >
            {PLANES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </label>
      )}
      {answer.status === 'loading' && <StatusLine text="Tracing the loops…" />}
      {answer.status === 'done' && view === null && <StatusLine text={answer.summary} testId="topology-rebuild-summary" />}
      {view !== null && box !== null && (
        <figure className="analysis__figure">
          <svg viewBox={box} className="topology__plot topology__plot--loops" role="img" aria-label="Suggested rebuild loops">
            <path d={view.loops.map(loopPath).join(' ')} fillRule="evenodd" className="topology__loops" vectorEffect="non-scaling-stroke" />
          </svg>
          <figcaption className="analysis__caption" data-testid="topology-rebuild-caption">
            {view.loops.filter((loop) => loop.orientation === 'outer').length} outer loop(s),{' '}
            {view.loops.filter((loop) => loop.orientation === 'hole').length} hole(s) on {view.plane}
            {view.droppedLoops > 0 ? `, ${view.droppedLoops} speck(s) dropped` : ''}. Model them with extrude_profile and subtract the
            holes.
          </figcaption>
        </figure>
      )}
      {view !== null && view.loops.length === 0 && <p className="analysis__none">No loops at this threshold.</p>}
    </div>
  );
}

export function TopologyReview({ study }: { study: TopologyStudy }): React.ReactElement {
  const document = useStore((s) => s.document);
  const selection = document.selection;
  const [rebuildIds, setRebuildIds] = useState<readonly string[]>([]);
  const [preview, setPreview] = useState(false);
  const params = useMemo(
    () => ({ studyId: study.id, ...(rebuildIds.length > 0 ? { rebuildEntityIds: [...rebuildIds] } : {}) }),
    [study.id, rebuildIds],
  );
  const checked = useHostQuery('check_topology', params, document);
  const check = checked.status === 'done' ? parseTopologyCheck(checked.data) : null;
  const tone = check?.status === 'pass' ? 'ok' : check?.status === 'fail' ? 'bad' : 'warn';

  return (
    <>
      <PanelSection title="Checks" hint="Readiness and review findings of the study, with the fix for each.">
        {checked.status === 'loading' && <StatusLine text="Checking…" />}
        {checked.status === 'done' && check === null && <StatusLine text={checked.summary} testId="topology-check-summary" />}
        {check !== null && (
          <>
            <StatusChip tone={tone} text={check.status} testId="topology-check-status" />
            <ul className="analysis__items" aria-label="Topology checks" data-testid="topology-check-items">
              {check.items.map((item) => (
                <li key={`${item.code}-${item.message}`} className={`analysis__item analysis__item--${item.severity}`}>
                  <span className="analysis__item-name">{item.code}</span>
                  <span className="analysis__item-detail">
                    {item.message}
                    {item.remediation !== '' ? ` — ${item.remediation}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          data-testid="topology-check-rebuild"
          disabled={selection.length === 0}
          onClick={() => setRebuildIds([...selection])}
        >
          Compare selection as rebuild
        </button>
        {rebuildIds.length > 0 && <p className="analysis__line">Rebuild compared: {rebuildIds.join(', ')}</p>}
      </PanelSection>
      <PanelSection title="Rebuild" hint="Closed loops that outline the optimised layout, to model by hand.">
        {preview ? (
          <RebuildPreview study={study} />
        ) : (
          <button type="button" className="btn btn--ghost btn--sm" data-testid="topology-preview-rebuild" onClick={() => setPreview(true)}>
            Preview rebuild loops
          </button>
        )}
      </PanelSection>
    </>
  );
}
