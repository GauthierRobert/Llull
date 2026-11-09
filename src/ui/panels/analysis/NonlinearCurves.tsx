// Load-displacement curves of a solved nonlinear_static case: nonlinear_report (curves, steps, plastic strain) and limit_load, with an increment slider.
// Read-only: every number comes from those commands; the panel only draws and reads them.

import React, { useId, useState } from 'react';
import type { AnalysisCase } from '@core/model/analysis';
import { PanelSection, StatusChip, StatusLine } from '@ui/panels/PanelParts';
import { useStore } from '@ui/store';
import { formatSignificant } from './quantityFormat';
import { parseLimitLoad, parseNonlinearReport, plotCurve, type CurveView, type PlotSize } from './nonlinearCurveData';
import { useHostQuery } from './useHostQuery';

const PLOT: PlotSize = { width: 320, height: 200, margin: 24 };
const NOT_APPROVED = 'Computed by llull, not approved: needs a qualified engineer.';

function CurvePlot({ analysisId, curve }: { analysisId: string; curve: CurveView }): React.ReactElement {
  const ids = useId();
  const document = useStore((s) => s.document);
  const [index, setIndex] = useState<number | null>(null);
  const limitParams = { analysisId, probe: curve.probeId, method: 'auto' };
  const limitAnswer = useHostQuery('limit_load', limitParams, document);
  const limit = limitAnswer.status === 'done' && !limitAnswer.isError ? parseLimitLoad(limitAnswer.data) : null;
  const plot = plotCurve(curve, PLOT);
  const last = Math.max(0, curve.load.length - 1);
  const shown = Math.min(index ?? last, last);
  const marker = plot.at(shown);
  const load = Math.abs(curve.load[shown] ?? 0);
  const displacement = Math.abs(curve.displacement[shown] ?? 0);
  return (
    <div className="analysis__curve" data-testid={`nonlinear-curve-${curve.probeId}`}>
      <p className="analysis__line">
        <strong>{curve.name}</strong> · {curve.points} points · peak load {formatSignificant(curve.maxLoad, 5)} {curve.loadUnit}
        {curve.snapBack && (
          <>
            {' '}
            <StatusChip tone="warn" text="snap-back" testId={`nonlinear-snapback-${curve.probeId}`} />
          </>
        )}
      </p>
      <svg
        className="analysis__plot"
        viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
        role="img"
        aria-label={`Load-displacement curve of ${curve.name}: load (${curve.loadUnit}) against displacement (${curve.displacementUnit}), magnitudes`}
        data-testid={`nonlinear-plot-${curve.probeId}`}
      >
        <line x1={PLOT.margin} y1={PLOT.height - PLOT.margin} x2={PLOT.width - PLOT.margin} y2={PLOT.height - PLOT.margin} stroke="#888" />
        <line x1={PLOT.margin} y1={PLOT.margin} x2={PLOT.margin} y2={PLOT.height - PLOT.margin} stroke="#888" />
        <polyline points={plot.polyline} fill="none" stroke="#1f6feb" strokeWidth={1.5} />
        <circle cx={marker.x} cy={marker.y} r={4} fill="#d1242f" data-testid={`nonlinear-marker-${curve.probeId}`} />
      </svg>
      <label className="field" htmlFor={`${ids}-slider`}>
        <span className="field__label">Increment</span>
        <input
          id={`${ids}-slider`}
          type="range"
          min={0}
          max={last}
          step={1}
          value={shown}
          data-testid={`nonlinear-slider-${curve.probeId}`}
          onChange={(event) => setIndex(Number(event.target.value))}
        />
      </label>
      <p className="analysis__caption" data-testid={`nonlinear-readout-${curve.probeId}`}>
        Sample {shown + 1} of {curve.load.length}: load {formatSignificant(load, 5)} {curve.loadUnit} at displacement{' '}
        {formatSignificant(displacement, 5)} {curve.displacementUnit}
      </p>
      {curve.load.length < curve.points && (
        <p className="analysis__hint">
          Showing {curve.load.length} evenly spread samples of {curve.points} points (summary view).
        </p>
      )}
      {limit !== null && (
        <p className="analysis__line" data-testid={`nonlinear-limit-${curve.probeId}`}>
          {limit.kind === 'limit'
            ? `Limit load ${formatSignificant(limit.value, 5)} ${limit.loadUnit} (${limit.method}) at displacement ${formatSignificant(limit.atDisplacement, 5)} ${limit.lengthUnit}`
            : `Limit not reached: the load is at least ${formatSignificant(limit.value, 5)} ${limit.loadUnit} (lower bound, the curve is still rising)`}
        </p>
      )}
    </div>
  );
}

export function NonlinearCurves({ analysisCase }: { analysisCase: AnalysisCase }): React.ReactElement {
  const document = useStore((s) => s.document);
  const params = { analysisId: analysisCase.id, increments: 'summary' };
  const answer = useHostQuery('nonlinear_report', params, document);
  const view = answer.status === 'done' && !answer.isError ? parseNonlinearReport(answer.data) : null;
  return (
    <PanelSection
      title="Nonlinear curves"
      hint="Load-displacement curves, convergence and plastic strain of the solved case (nonlinear_report, limit_load)."
    >
      {answer.status === 'loading' && <StatusLine text="Reading the nonlinear results…" />}
      {answer.status === 'done' && view === null && <StatusLine text={answer.summary} testId="nonlinear-summary" />}
      {view !== null && (
        <>
          <p className="analysis__line" data-testid="nonlinear-status">
            nlgeom {String(view.nlgeom)} · {view.steps.reduce((sum, step) => sum + step.increments, 0)} increments in {view.steps.length}{' '}
            step(s), {view.steps.reduce((sum, step) => sum + step.cutbacks, 0)} cutback(s) ·{' '}
            {view.completed ? 'all steps completed' : 'NOT all steps completed'}
            {view.maxPeeq === null ? '' : ` · max equivalent plastic strain ${formatSignificant(view.maxPeeq, 4)}`}
          </p>
          {view.unverified && (
            <p className="analysis__hint" data-testid="nonlinear-unverified">
              <StatusChip tone="warn" text="unverified inputs" /> {view.unverifiedReasons.join('; ')}
            </p>
          )}
          {view.curves.length === 0 && <StatusLine text="No curve probes (add_curve_probe)." testId="nonlinear-empty" />}
          {view.curves.map((curve) => (
            <CurvePlot key={curve.probeId} analysisId={analysisCase.id} curve={curve} />
          ))}
          <p className="analysis__hint" data-testid="nonlinear-review">
            {NOT_APPROVED}
          </p>
        </>
      )}
    </PanelSection>
  );
}
