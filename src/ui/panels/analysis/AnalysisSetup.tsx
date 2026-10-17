// Reviewable summary of the recorded set-up of one analysis case: parts, materials, constraints, loads, thermal BCs, mesh, probes.

import React from 'react';
import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { PanelSection } from '@ui/panels/PanelParts';
import { constraintText, loadText, thermalBcText, type NameOf } from './analysisText';

interface SetupItem {
  readonly key: string;
  readonly name: string;
  readonly detail: string;
}

function ItemList({ label, items, empty }: { label: string; items: readonly SetupItem[]; empty: string }): React.ReactElement {
  if (items.length === 0) return <p className="analysis__none">{empty}</p>;
  return (
    <ul className="analysis__items" aria-label={label}>
      {items.map((item) => (
        <li key={item.key} className="analysis__item">
          <span className="analysis__item-name">{item.name}</span>
          <span className="analysis__item-detail">{item.detail}</span>
        </li>
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
  const parts: SetupItem[] = Object.entries(analysisCase.parts).map(([entityId, idealization]) => {
    const materialId = document.entities[entityId]?.materialId;
    const material = materialId === undefined ? undefined : document.materials[materialId]?.name;
    return { key: entityId, name: nameOf(entityId), detail: `${idealization.kind} · ${material ?? 'no material'}` };
  });
  const constraints = analysisCase.constraintOrder.flatMap((id) => {
    const constraint = analysisCase.constraints[id];
    return constraint === undefined ? [] : [{ key: id, name: constraint.name, detail: constraintText(constraint, nameOf) }];
  });
  const loads = analysisCase.loadOrder.flatMap((id) => {
    const load = analysisCase.loads[id];
    return load === undefined
      ? []
      : [{ key: id, name: load.name, detail: `${loadText(load, nameOf)} · ${load.loadCase} (${load.category})` }];
  });
  const bcs = (analysisCase.thermal?.bcOrder ?? []).flatMap((id) => {
    const record = analysisCase.thermal?.bcs[id];
    return record === undefined ? [] : [{ key: id, name: record.name, detail: thermalBcText(record, nameOf) }];
  });
  const probes = Object.entries(analysisCase.probes).map(([id, probe]) => ({
    key: id,
    name: probe.name,
    detail: `${probe.quantity} at [${probe.point.join(', ')}]`,
  }));
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
        <ItemList label="Parts" items={parts} empty="No parts yet (set_part_idealization)." />
      </PanelSection>
      <PanelSection title="Constraints" count={constraints.length} countLabel={`${constraints.length} constraints`}>
        <ItemList label="Constraints" items={constraints} empty="No supports." />
      </PanelSection>
      <PanelSection title="Loads" count={loads.length} countLabel={`${loads.length} loads`}>
        <ItemList label="Loads" items={loads} empty="No loads." />
      </PanelSection>
      {analysisCase.thermal !== undefined && (
        <PanelSection title="Thermal BCs" count={bcs.length} countLabel={`${bcs.length} thermal boundary conditions`}>
          <ItemList label="Thermal BCs" items={bcs} empty="No thermal boundary conditions." />
        </PanelSection>
      )}
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
        <ItemList label="Probes" items={probes} empty="No probes." />
      </PanelSection>
    </div>
  );
}
