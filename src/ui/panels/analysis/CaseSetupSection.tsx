// Analysis › Set-up: what the case analyses and how it is held and loaded, read straight from the recorded case (parts with their
// material, supports, loads per load case, thermal conditions and limits, safety factors, mesh controls).

import React from 'react';
import type { AnalysisCase } from '@core/model/analysis';
import { useStore } from '@ui/store';
import { PanelSection } from '@ui/panels/PanelParts';
import { THERMAL_BC_LABELS, formatNumber, isThermalCase, loadValue, thermalBcValue } from './analysisView';

function SetupRow({ title, value, meta, testId }: { title: string; value: string; meta?: string; testId?: string }): React.ReactElement {
  return (
    <li className="analysis-setup__row" data-testid={testId}>
      <span className="analysis-setup__name">{title}</span>
      <span className="analysis-setup__value">{value}</span>
      {meta !== undefined && <span className="analysis-setup__meta">{meta}</span>}
    </li>
  );
}

function SetupGroup({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <>
      <h4 className="mfg__subhead">{label}</h4>
      <ul className="analysis-setup">{children}</ul>
    </>
  );
}

export function CaseSetupSection({ analysis }: { analysis: AnalysisCase }): React.ReactElement {
  const entities = useStore((s) => s.document.entities);
  const thermal = isThermalCase(analysis.type) ? analysis.thermal : undefined;
  const partIds = Object.keys(analysis.parts);
  const loadCases = [...new Set(analysis.loadOrder.map((id) => analysis.loads[id]?.loadCase ?? ''))].filter((name) => name !== '');
  const limits = Object.values(thermal?.limits ?? {});
  const { factors, mesh } = analysis;

  return (
    <PanelSection title="Set-up" step={1} done={partIds.length > 0} testId="analysis-setup">
      <SetupGroup label="Parts">
        {partIds.length === 0 && <SetupRow title="None yet" value="set_part_idealization" />}
        {partIds.map((id) => {
          const entity = entities[id];
          return (
            <SetupRow
              key={id}
              title={entity?.name ?? id}
              value="3D solid (tet)"
              meta={entity?.materialId ?? 'no material'}
              testId={`analysis-part-${id}`}
            />
          );
        })}
      </SetupGroup>
      {analysis.constraintOrder.length > 0 && (
        <SetupGroup label="Supports">
          {analysis.constraintOrder.map((id) => {
            const constraint = analysis.constraints[id];
            return constraint === undefined ? null : <SetupRow key={id} title={constraint.name} value={constraint.kind} />;
          })}
        </SetupGroup>
      )}
      {loadCases.map((loadCase) => (
        <SetupGroup key={loadCase} label={`Load case ${loadCase}`}>
          {analysis.loadOrder.map((id) => {
            const load = analysis.loads[id];
            if (load === undefined || load.loadCase !== loadCase) return null;
            return (
              <SetupRow
                key={id}
                title={load.name}
                value={loadValue(load, analysis.unitSystem)}
                meta={load.category}
                testId={`analysis-load-${id}`}
              />
            );
          })}
        </SetupGroup>
      ))}
      {thermal !== undefined && thermal.bcOrder.length > 0 && (
        <SetupGroup label="Thermal conditions">
          {thermal.initialTemperature !== undefined && (
            <SetupRow
              title="Initial temperature"
              value={`${formatNumber(thermal.initialTemperature.value)} ${thermal.initialTemperature.unit}`}
            />
          )}
          {thermal.bcOrder.map((id) => {
            const record = thermal.bcs[id];
            return record === undefined ? null : (
              <SetupRow key={id} title={record.name} value={thermalBcValue(record.bc)} meta={THERMAL_BC_LABELS[record.bc.kind]} />
            );
          })}
        </SetupGroup>
      )}
      {limits.length > 0 && (
        <SetupGroup label="Temperature limits">
          {limits.map((limit) => (
            <SetupRow
              key={limit.id}
              title={limit.name}
              value={[
                limit.min && `≥ ${formatNumber(limit.min.value)} ${limit.min.unit}`,
                limit.max && `≤ ${formatNumber(limit.max.value)} ${limit.max.unit}`,
              ]
                .filter(Boolean)
                .join(' · ')}
              meta={limit.source.citation}
            />
          ))}
        </SetupGroup>
      )}
      <p className="mfg__figures analysis-setup__footer" data-testid="analysis-factors">
        {!isThermalCase(analysis.type) && (
          <>
            Factors: ultimate {factors.ultimate} · yield {factors.yield}
            {factors.extra.map((extra) => ` · ${extra.name} ${extra.value}`).join('')}
            <br />
          </>
        )}
        Mesh: {mesh.elementFamily} order {mesh.order}, {formatNumber(mesh.globalSize)} {analysis.unitSystem === 'N-mm-t-s' ? 'mm' : 'units'}
        {mesh.refinements.length > 0 && `, ${mesh.refinements.length} refinement(s)`} · {analysis.unitSystem}
      </p>
    </PanelSection>
  );
}
