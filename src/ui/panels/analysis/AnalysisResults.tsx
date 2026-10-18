// Results of a solved analysis: the contour plot of render_fea_results with field / view / load-case / deformation controls.

import React, { useId, useState } from 'react';
import type { AnalysisCase } from '@core/model/analysis';
import { ModalDialog } from '@ui/components/ModalDialog';
import { PanelSection, StatusLine } from '@ui/panels/PanelParts';
import { svgDataUrl } from './analysisData';
import { useFeaRender } from './useFeaRender';

const STRUCTURAL_FIELDS = ['von_mises', 'u_mag', 'u_x', 'u_y', 'u_z', 's_xx', 's_yy', 's_zz'] as const;
const THERMAL_FIELDS = ['temperature', 'heat_flux'] as const;
const EIGEN_FIELDS = ['mode'] as const;
const VIEWS = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'] as const;

const isEigen = (analysisCase: AnalysisCase): boolean => analysisCase.type === 'modal' || analysisCase.type === 'buckling';
const isHeat = (analysisCase: AnalysisCase): boolean => analysisCase.type === 'heat_steady' || analysisCase.type === 'heat_transient';
const loadCasesOf = (analysisCase: AnalysisCase): string[] => [...new Set(Object.values(analysisCase.loads).map((load) => load.loadCase))];

const round = (n: number): string => String(Math.round(n * 1e4) / 1e4);

function SolveHint({ analysisId }: { analysisId: string }): React.ReactElement {
  return (
    <p className="analysis__hint" data-testid="analysis-solve-hint">
      Solve with <code>llull fea_mesh analysisId={analysisId}</code> then <code>llull fea_solve analysisId={analysisId}</code> (needs the
      server with CalculiX + Gmsh).
    </p>
  );
}

export function AnalysisResults({ analysisCase }: { analysisCase: AnalysisCase }): React.ReactElement {
  const ids = useId();
  const heat = isHeat(analysisCase);
  const eigen = isEigen(analysisCase);
  const fields = heat ? THERMAL_FIELDS : eigen ? EIGEN_FIELDS : STRUCTURAL_FIELDS;
  const loadCases = heat || eigen ? [] : loadCasesOf(analysisCase);
  const [field, setField] = useState<string>(fields[0]);
  const [view, setView] = useState<string>('iso');
  const [loadCase, setLoadCase] = useState('');
  const [mode, setMode] = useState('1');
  const [scale, setScale] = useState('');
  const [full, setFull] = useState(false);

  const scaleValue = scale.trim() === '' ? Number.NaN : Number(scale);
  const params: Record<string, unknown> = {
    analysisId: analysisCase.id,
    field,
    view,
    ...(eigen && Number.isInteger(Number(mode)) && Number(mode) >= 1 ? { mode: Number(mode) } : {}),
    ...(loadCase !== '' ? { loadCase } : {}),
    ...(Number.isFinite(scaleValue) && scaleValue >= 0 ? { deformationScale: scaleValue } : {}),
  };
  const render = useFeaRender(params, analysisCase);
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
              onChange={(e) => setMode(e.target.value)}
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
      </div>
      {render.status === 'loading' && <StatusLine text="Rendering…" />}
      {render.status === 'refused' && (
        <>
          <StatusLine text={render.summary} testId="analysis-results-summary" />
          <SolveHint analysisId={analysisCase.id} />
        </>
      )}
      {render.status === 'ready' && (
        <figure className="analysis__figure">
          <img className="analysis__plot" data-testid="analysis-plot" alt={`${render.view.field} contour plot`} src={image} />
          <figcaption className="analysis__caption" data-testid="analysis-extremes">
            {render.view.field} [{render.view.unit}] · {render.view.resultLabel}
            <br />
            min {round(render.view.min.value)} · max {round(render.view.max.value)} {render.view.unit}
            {render.view.deformationScale > 0 ? ` · deformation ×${render.view.deformationScale}` : ''}
          </figcaption>
          <button type="button" className="btn btn--ghost" data-testid="analysis-open-full" onClick={() => setFull(true)}>
            Open full size
          </button>
        </figure>
      )}
      {full && render.status === 'ready' && (
        <ModalDialog
          backdropClassName="shortcuts-backdrop"
          className="shortcuts-dialog analysis__dialog"
          onClose={() => setFull(false)}
          label="Analysis results, full size"
          initialFocus="first"
        >
          <img className="analysis__plot analysis__plot--full" alt={`${render.view.field} contour plot, full size`} src={image} />
          <button type="button" className="btn btn--ghost" onClick={() => setFull(false)}>
            Close
          </button>
        </ModalDialog>
      )}
    </PanelSection>
  );
}
