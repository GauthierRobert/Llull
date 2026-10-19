// Topology optimisation of one analysis case (PHY-17): studies, set-up, solve, verified result, checks and rebuild preview.
// Review only: every change is a dispatched command; the solve is the host's topology_solve tool.

import React, { useMemo, useState } from 'react';
import type { TopologyStudy } from '@core/model/topology';
import { useStore } from '@ui/store';
import { DeleteButton, ListRow, PanelSection } from '@ui/panels/PanelParts';
import { TopologyCreate } from './TopologyCreate';
import { TopologyRegions } from './TopologyRegions';
import { TopologyReport } from './TopologyReport';
import { TopologyReview } from './TopologyReview';
import { TopologySettings } from './TopologySettings';
import { TopologySolve } from './TopologySolve';
import { parseTopologyReport } from './topologyData';
import { useHostQuery } from './useHostQuery';

function StudyDetail({ study }: { study: TopologyStudy }): React.ReactElement {
  const document = useStore((s) => s.document);
  const params = useMemo(() => ({ studyId: study.id, historyRows: 1000 }), [study.id]);
  const answer = useHostQuery('topology_report', params, document);
  const report = answer.status === 'done' ? parseTopologyReport(answer.data) : null;
  return (
    <div data-testid="topology-detail">
      <p className="analysis__line">
        {study.dimension === 2 ? `2D ${study.plane ?? 'XY'}` : '3D'} · voxel {study.voxel} {document.units} · volume fraction{' '}
        {study.volumeFraction} · {study.designDomain.length} solid(s)
      </p>
      <TopologySolve studyId={study.id} />
      <TopologyReport study={study} report={report} summary={answer.status === 'done' ? answer.summary : 'Reading the result…'} />
      <TopologyReview study={study} />
      <TopologySettings key={`${study.id}-${JSON.stringify(study.settings)}`} study={study} />
      <TopologyRegions study={study} />
    </div>
  );
}

export function TopologyPanel({ analysisId }: { analysisId: string }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const analysisCase = useStore((s) => s.document.analysis?.cases[analysisId]);
  const studies = useMemo(
    () =>
      (analysisCase?.topologyOrder ?? []).flatMap((id) => (analysisCase?.topology?.[id] === undefined ? [] : [analysisCase.topology[id]])),
    [analysisCase],
  );
  const [pickedId, setPickedId] = useState<string | null>(null);
  const selected = studies.find((study) => study.id === pickedId) ?? studies[0] ?? null;

  return (
    <div data-testid="topology-panel" aria-label="Topology optimisation">
      <PanelSection
        title="Topology studies"
        count={studies.length}
        countLabel={`${studies.length} topology studies`}
        hint="Find the stiffest layout of a design domain for a share of its volume."
      >
        {studies.length === 0 ? (
          <p className="analysis__none">No topology study on this analysis yet.</p>
        ) : (
          <ul className="panel__list" aria-label="Topology studies">
            {studies.map((study) => (
              <ListRow
                key={study.id}
                testId={`topology-row-${study.id}`}
                buttonTestId={`topology-open-${study.id}`}
                selected={study.id === selected?.id}
                current={study.id === selected?.id}
                label={`Open topology study ${study.name}`}
                onSelect={() => setPickedId(study.id)}
                actions={
                  <DeleteButton
                    label={`Delete topology study ${study.name}`}
                    onDelete={() => dispatch('delete_topology_study', { studyId: study.id })}
                  />
                }
              >
                <span className="panel__row-main">{study.name}</span>
                <span className="panel__row-meta">{study.result === undefined ? 'unsolved' : `${study.result.iterations} it`}</span>
              </ListRow>
            ))}
          </ul>
        )}
      </PanelSection>
      {selected !== null && <StudyDetail key={selected.id} study={selected} />}
      <TopologyCreate analysisId={analysisId} />
    </div>
  );
}
