// Reviewable summary of the recorded set-up of one analysis case: parts, materials, constraints, loads, thermal BCs, mesh, probes.
// Every row is clickable (highlights the item on the model) and wears the colour it is drawn with there.

import React, { useMemo } from 'react';
import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { PanelSection } from '@ui/panels/PanelParts';
import { buildSetupItems, loadValueText, type SetupItem } from './analysisItems';
import { constraintText, factorsText, loadText, stepText, thermalBcText, type NameOf } from './analysisText';
import { SetupRow } from './SetupRow';

interface RowSpec {
  readonly item: SetupItem;
  readonly meta: string;
  readonly detail: string;
}

function ItemList({ label, rows, empty }: { label: string; rows: readonly RowSpec[]; empty: string }): React.ReactElement {
  if (rows.length === 0) return <p className="analysis__none">{empty}</p>;
  return (
    <ul className="panel__list" aria-label={label}>
      {rows.map(({ item, meta, detail }) => (
        <SetupRow key={item.key} item={item} meta={meta} detail={detail} />
      ))}
    </ul>
  );
}

interface AnalysisSetupProps {
  analysisCase: AnalysisCase;
  document: CadDocument;
}

export function AnalysisSetup({ analysisCase, document }: AnalysisSetupProps): React.ReactElement {
  const nameOf: NameOf = (entityId) => document.entities[entityId]?.name ?? entityId;
  const items = useMemo(() => buildSetupItems(document, analysisCase), [document, analysisCase]);
  const parts: RowSpec[] = items.parts.map((item) => {
    const entityId = item.entityIds[0] ?? '';
    const materialId = document.entities[entityId]?.materialId;
    const material = materialId === undefined ? undefined : document.materials[materialId]?.name;
    return { item, meta: `${analysisCase.parts[entityId]?.kind ?? 'solid'} · ${material ?? 'no material'}`, detail: '' };
  });
  const constraints: RowSpec[] = items.constraints.flatMap((item) => {
    const constraint = analysisCase.constraints[item.id];
    return constraint === undefined ? [] : [{ item, meta: constraint.kind, detail: constraintText(constraint, nameOf) }];
  });
  const loads: RowSpec[] = items.loads.flatMap((item) => {
    const load = analysisCase.loads[item.id];
    if (load === undefined) return [];
    const value = loadValueText(load, analysisCase.unitSystem);
    return [{ item, meta: `${value} · ${load.loadCase}`, detail: `${loadText(load, nameOf)} · ${load.loadCase} (${load.category})` }];
  });
  const bcs: RowSpec[] = items.thermal.flatMap((item) => {
    const record = analysisCase.thermal?.bcs[item.id];
    return record === undefined ? [] : [{ item, meta: item.label, detail: thermalBcText(record, nameOf) }];
  });
  const probes: RowSpec[] = items.probes.flatMap((item) => {
    const probe = analysisCase.probes[item.id];
    return probe === undefined ? [] : [{ item, meta: probe.quantity, detail: `${probe.quantity} at [${probe.point.join(', ')}]` }];
  });
  const { mesh, meshSummary } = analysisCase;
  const elements =
    meshSummary === undefined
      ? ''
      : Object.entries(meshSummary.elements)
          .map(([type, n]) => `${n} ${type}`)
          .join(', ');

  return (
    <div data-testid="analysis-setup">
      <PanelSection title="Parts" count={parts.length} countLabel={`${parts.length} parts`}>
        <ItemList label="Parts" rows={parts} empty="No parts yet (set_part_idealization)." />
      </PanelSection>
      <PanelSection title="Constraints" count={constraints.length} countLabel={`${constraints.length} constraints`}>
        <ItemList label="Constraints" rows={constraints} empty="No supports." />
      </PanelSection>
      <PanelSection title="Loads" count={loads.length} countLabel={`${loads.length} loads`}>
        <ItemList label="Loads" rows={loads} empty="No loads." />
      </PanelSection>
      {analysisCase.thermal !== undefined && (
        <PanelSection title="Thermal BCs" count={bcs.length} countLabel={`${bcs.length} thermal boundary conditions`}>
          <ItemList label="Thermal BCs" rows={bcs} empty="No thermal boundary conditions." />
        </PanelSection>
      )}
      <PanelSection title="Solution" testId="analysis-solution">
        {(analysisCase.type === 'modal' || analysisCase.type === 'buckling') && (
          <p className="analysis__line" data-testid="analysis-modes-requested">
            Requested modes: {analysisCase.modes ?? 'default'}
          </p>
        )}
        {analysisCase.thermal !== undefined && (
          <p className="analysis__line" data-testid="analysis-initial-temperature">
            Initial temperature:{' '}
            {analysisCase.thermal.initialTemperature === undefined
              ? 'not set'
              : `${analysisCase.thermal.initialTemperature.value} ${analysisCase.thermal.initialTemperature.unit}`}
          </p>
        )}
        {analysisCase.type === 'heat_transient' && analysisCase.thermal !== undefined && (
          <p className="analysis__line" data-testid="analysis-time-stepping">
            Time stepping: {stepText(analysisCase.thermal.step)}
          </p>
        )}
        <p className="analysis__line" data-testid="analysis-factors">
          Safety factors: {factorsText(analysisCase.factors)}
        </p>
      </PanelSection>
      <PanelSection title="Mesh" collapsible>
        <p className="analysis__line">
          {mesh.mesher} · {mesh.elementFamily} · order {mesh.order} · size {mesh.globalSize}
          {mesh.refinements.length > 0 ? ` · ${mesh.refinements.length} refinements` : ''}
        </p>
        <p className="analysis__line">
          {meshSummary === undefined ? 'Not meshed.' : `${meshSummary.nodes} nodes${elements !== '' ? `, ${elements}` : ''}`}
        </p>
      </PanelSection>
      <PanelSection title="Probes" count={probes.length} countLabel={`${probes.length} probes`} collapsible defaultOpen={probes.length > 0}>
        <ItemList label="Probes" rows={probes} empty="No probes." />
      </PanelSection>
    </div>
  );
}
