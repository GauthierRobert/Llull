// Results of a solved analysis: the contour plot of render_fea_results with field / view / load-case / deformation controls.

import React, { useId, useState } from 'react';
import type { AnalysisCase } from '@core/model/analysis';
import { PanelSection, StatusLine } from '@ui/panels/PanelParts';
import { svgDataUrl } from './analysisData';
import { PlotDialog } from './PlotDialog';
import { formatQuantities, formatSignificant } from './quantityFormat';
import { useFeaRender } from './useFeaRender';

const STRUCTURAL_FIELDS = ['von_mises', 'u_mag', 'u_x', 'u_y', 'u_z', 's_xx', 's_yy', 's_zz'] as const;
const THERMAL_FIELDS = ['temperature', 'heat_flux'] as const;
const EIGEN_FIELDS = ['mode'] as const;
const VIEWS = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'] as const;

const isEigen = (analysisCase: AnalysisCase): boolean => analysisCase.type === 'modal' || analysisCase.type === 'buckling';
const isHeat = (analysisCase: AnalysisCase): boolean => analysisCase.type === 'heat_steady' || analysisCase.type === 'heat_transient';
const loadCasesOf = (analysisCase: AnalysisCase): string[] => [...new Set(Object.values(analysisCase.loads).map((load) => load.loadCase))];

const timesOf = (analysisCase: AnalysisCase): readonly number[] =>
  analysisCase.type === 'heat_transient' ? (analysisCase.results?.thermal?.times ?? []) : [];

function SolveHint({ analysisId }: { analysisId: string }): React.ReactElement {
  return (
    <p className="analysis__hint" data-testid="analysis-solve-hint">
      Solve with <code>llull fea_mesh analysisId={analysisId}</code> then <code>llull fea_solve analysisId={analysisId}</code> (needs the
      server with CalculiX + Gmsh).
    </p>
  );
}

interface AnalysisResultsProps {
  analysisCase: AnalysisCase;
  /** Mode plotted for modal / buckling cases (1-based); owned by the panel so the mode list can select it. */
  mode: number;
  onModeChange: (mode: number) => void;
}

export function AnalysisResults({ analysisCase, mode, onModeChange }: AnalysisResultsProps): React.ReactElement {
  const ids = useId();
  const heat = isHeat(analysisCase);
  const eigen = isEigen(analysisCase);
  const fields = heat ? THERMAL_FIELDS : eigen ? EIGEN_FIELDS : STRUCTURAL_FIELDS;
  const loadCases = heat || eigen ? [] : loadCasesOf(analysisCase);
  const times = timesOf(analysisCase);
  const [field, setField] = useState<string>(fields[0]);
  const [view, setView] = useState<string>('iso');
  const [loadCase, setLoadCase] = useState('');
  const [time, setTime] = useState('');
  const [showMesh, setShowMesh] = useState(false);
  const [scale, setScale] = useState('');
  const [full, setFull] = useState(false);

  const scaleValue = scale.trim() === '' ? Number.NaN : Number(scale);
  const params: Record<string, unknown> = {
    analysisId: analysisCase.id,
    field,
    view,
    ...(eigen && Number.isInteger(mode) && mode >= 1 ? { mode } : {}),
    ...(time !== '' ? { time: Number(time) } : {}),
    ...(showMesh ? { showMesh: true } : {}),
    ...(loadCase !== '' ? { loadCase } : {}),
    ...(Number.isFinite(scaleValue) && scaleValue >= 0 ? { deformationScale: scaleValue } : {}),
  };
  const render = useFeaRender(params, analysisCase);
  const extremes = render.status === 'ready' ? formatQuantities([render.view.min.value, render.view.max.value], render.view.unit) : null;
  const image = render.status === 'ready' ? svgDataUrl(render.view.svg) : '';

  return (
    <PanelSection title="Results" hint="Contour plot of the solved fields (server artifacts).">
      <div className="analysis__controls">
        <label className="field" htmlFor={`${ids}-field`}>
          <span className="field__label">Field</span>
          <select id={`${ids}-field`} data-testid="analysis-field" value={field} onChange={(e) => setField(e.target.value)}>
            {fields.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor={`${ids}-view`}>
          <span className="field__label">View</span>
          <select id={`${ids}-view`} data-testid="analysis-view" value={view} onChange={(e) => setView(e.target.value)}>
            {VIEWS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {loadCases.length > 1 && (
          <label className="field" htmlFor={`${ids}-lc`}>
            <span className="field__label">Load case</span>
            <select id={`${ids}-lc`} data-testid="analysis-load-case" value={loadCase} onChange={(e) => setLoadCase(e.target.value)}>
              <option value="">first</option>
              {loadCases.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        {times.length > 1 && (
          <label className="field" htmlFor={`${ids}-time`}>
            <span className="field__label">Time</span>
            <select id={`${ids}-time`} data-testid="analysis-time" value={time} onChange={(e) => setTime(e.target.value)}>
              <option value="">last</option>
              {times.map((t) => (
                <option key={t} value={t}>
                  {formatSignificant(t)} s
                </option>
              ))}
            </select>
          </label>
        )}
        {eigen && (
          <label className="field" htmlFor={`${ids}-mode`}>
            <span className="field__label">Mode</span>
            <input
              id={`${ids}-mode`}
              type="number"
              min={1}
              step={1}
              data-testid="analysis-mode"
              value={mode}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (Number.isInteger(next) && next >= 1) onModeChange(next);
              }}
            />
          </label>
        )}
        {!heat && !eigen && (
          <label className="field" htmlFor={`${ids}-scale`}>
            <span className="field__label">Deform ×</span>
            <input
              id={`${ids}-scale`}
              type="number"
              min={0}
              placeholder="auto"
              data-testid="analysis-scale"
              value={scale}
              onChange={(e) => setScale(e.target.value)}
            />
          </label>
        )}
        <label className="field analysis__check">
          <input type="checkbox" data-testid="analysis-show-mesh" checked={showMesh} onChange={(e) => setShowMesh(e.target.checked)} />
          <span>Show mesh edges</span>
        </label>
      </div>
      {render.status === 'loading' && <StatusLine text="Rendering…" />}
      {render.status === 'refused' && (
        <>
          <StatusLine text={render.summary} testId="analysis-results-summary" />
          <SolveHint analysisId={analysisCase.id} />
        </>
      )}
      {render.status === 'ready' && extremes !== null && (
        <figure className="analysis__figure">
          <img className="analysis__plot" data-testid="analysis-plot" alt={`${render.view.field} contour plot`} src={image} />
          <figcaption className="analysis__caption" data-testid="analysis-extremes">
            {render.view.field} · {render.view.resultLabel}
            <br />
            min {extremes.texts[0]} · max {extremes.texts[1]} {extremes.unit}
            {render.view.deformationScale > 0 ? ` · deformation ×${render.view.deformationScale}` : ''}
          </figcaption>
          <button type="button" className="btn btn--ghost" data-testid="analysis-open-full" onClick={() => setFull(true)}>
            Open full size
          </button>
        </figure>
      )}
      {full && render.status === 'ready' && (
        <PlotDialog
          src={image}
          alt={`${render.view.field} contour plot, full size`}
          label="Analysis results, full size"
          onClose={() => setFull(false)}
        />
      )}
    </PanelSection>
  );
}
