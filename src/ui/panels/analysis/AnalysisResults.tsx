// Results of a solved analysis: the contour plot of render_fea_results with field / view / load-case / deformation controls.

import React, { useId, useState } from 'react';
import type { AnalysisCase } from '@core/model/analysis';
import { useShallow } from 'zustand/react/shallow';
import { PanelSection, StatusLine } from '@ui/panels/PanelParts';
import { svgDataUrl } from './analysisData';
import { fieldsOf, isEigen, isHeat, loadCasesOf, resolvedField, resultParams, timesOf } from './analysisFields';
import { useAnalysisViewStore } from './analysisViewStore';
import { PlotDialog } from './PlotDialog';
import { formatQuantities, formatSignificant } from './quantityFormat';
import { useFeaRender } from './useFeaRender';

const VIEWS = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'] as const;

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
}

/** Field / load case / time / deformation / mode live in the view store: the 3D overlay paints the same result. */
export function AnalysisResults({ analysisCase }: AnalysisResultsProps): React.ReactElement {
  const ids = useId();
  const choice = useAnalysisViewStore(
    useShallow((s) => ({ field: s.field, loadCase: s.loadCase, time: s.time, scale: s.scale, mode: s.mode })),
  );
  const set = useAnalysisViewStore(
    useShallow((s) => ({ setField: s.setField, setLoadCase: s.setLoadCase, setTime: s.setTime, setScale: s.setScale, setMode: s.setMode })),
  );
  const heat = isHeat(analysisCase);
  const eigen = isEigen(analysisCase);
  const fields = fieldsOf(analysisCase);
  const loadCases = heat || eigen ? [] : loadCasesOf(analysisCase);
  const times = timesOf(analysisCase);
  const field = resolvedField(analysisCase, choice);
  const { loadCase, time, scale, mode } = choice;
  const [view, setView] = useState<string>('iso');
  const [showMesh, setShowMesh] = useState(false);
  const [full, setFull] = useState(false);

  const params: Record<string, unknown> = { ...resultParams(analysisCase, choice), view, ...(showMesh ? { showMesh: true } : {}) };
  const render = useFeaRender(params, analysisCase);
  const extremes = render.status === 'ready' ? formatQuantities([render.view.min.value, render.view.max.value], render.view.unit) : null;
  const image = render.status === 'ready' ? svgDataUrl(render.view.svg) : '';

  return (
    <PanelSection title="Results" hint="Pick the field here: it is painted on the model and drawn in the plot below (server artifacts).">
      <div className="analysis__controls">
        <label className="field" htmlFor={`${ids}-field`}>
          <span className="field__label">Field</span>
          <select id={`${ids}-field`} data-testid="analysis-field" value={field} onChange={(e) => set.setField(e.target.value)}>
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
            <select id={`${ids}-lc`} data-testid="analysis-load-case" value={loadCase} onChange={(e) => set.setLoadCase(e.target.value)}>
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
            <select id={`${ids}-time`} data-testid="analysis-time" value={time} onChange={(e) => set.setTime(e.target.value)}>
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
                if (Number.isInteger(next) && next >= 1) set.setMode(next);
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
              onChange={(e) => set.setScale(e.target.value)}
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
            Open plot full size
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
