// Colour legend of the result painted on the model (bottom-left of the viewport), and the host query that feeds the surface to the overlay.
// Says plainly why nothing is painted when the case is unsolved or the host cannot answer.

import React, { useEffect, useMemo } from 'react';
import '@ui/styles/panels/analysisOverlay.css';
import { useShallow } from 'zustand/react/shallow';
import { resultColor } from '@lib/isoBands';
import { useStore } from '@ui/store';
import { resultParams, resolvedField } from '@ui/panels/analysis/analysisFields';
import { useAnalysisViewStore, type SurfaceFeed } from '@ui/panels/analysis/analysisViewStore';
import { formatQuantities } from '@ui/panels/analysis/quantityFormat';
import { parseSurface, type SurfaceView } from '@ui/panels/analysis/surfaceData';
import { useHostQuery, type HostQueryState } from '@ui/panels/analysis/useHostQuery';

const FIELD_TITLES: Readonly<Record<string, string>> = {
  von_mises: 'von Mises stress',
  u_mag: 'Displacement',
  u_x: 'Displacement X',
  u_y: 'Displacement Y',
  u_z: 'Displacement Z',
  s_xx: 'Stress XX',
  s_yy: 'Stress YY',
  s_zz: 'Stress ZZ',
  temperature: 'Temperature',
  heat_flux: 'Heat flux',
  mode: 'Mode shape',
};

function feedOf(query: HostQueryState, unsolved: string): SurfaceFeed {
  if (unsolved !== '') return { status: 'idle', reason: unsolved };
  if (query.status === 'loading') return { status: 'loading' };
  const surface = query.isError ? null : parseSurface(query.data);
  return surface === null
    ? { status: 'refused', reason: query.summary || 'The host did not return a result surface.' }
    : { status: 'ready', surface };
}

function Ramp({ surface }: { surface: SurfaceView }): React.ReactElement {
  const bands = surface.levels.length - 1;
  const shown = formatQuantities(surface.levels, surface.unit);
  return (
    <ol className="analysis-legend__bands" aria-label="Colour bands">
      {Array.from({ length: bands }, (_, k) => bands - 1 - k).map((band) => (
        <li key={band} className="analysis-legend__band">
          <span className="analysis-legend__chip" style={{ background: resultColor((band + 0.5) / bands) }} />
          <span className="analysis-legend__tick">{shown.texts[band + 1]}</span>
        </li>
      ))}
      <li className="analysis-legend__band analysis-legend__band--floor">
        <span className="analysis-legend__chip analysis-legend__chip--none" />
        <span className="analysis-legend__tick">{shown.texts[0]}</span>
      </li>
    </ol>
  );
}

export function AnalysisLegend(): React.ReactElement | null {
  const analysisId = useAnalysisViewStore((s) => s.analysisId);
  const showOnModel = useAnalysisViewStore((s) => s.showOnModel);
  return showOnModel && analysisId !== null ? <LegendFeed key={analysisId} analysisId={analysisId} /> : null;
}

function LegendFeed({ analysisId }: { analysisId: string }): React.ReactElement | null {
  const analysisCase = useStore((s) => s.document.analysis?.cases[analysisId]);
  const choice = useAnalysisViewStore(
    useShallow((s) => ({ field: s.field, loadCase: s.loadCase, time: s.time, scale: s.scale, mode: s.mode })),
  );
  const setSurface = useAnalysisViewStore((s) => s.setSurface);
  const feed = useAnalysisViewStore((s) => s.surface);
  const unsolved =
    analysisCase === undefined ? 'Analysis not found.' : analysisCase.results === undefined ? 'Not solved yet: nothing to paint.' : '';
  const params = useMemo(
    () =>
      analysisCase === undefined || unsolved !== ''
        ? null
        : { ...resultParams(analysisCase, choice), surface: true, width: 320, height: 240 },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `choice` is rebuilt per render; its fields are the dependencies
    [analysisCase, unsolved, choice.field, choice.loadCase, choice.time, choice.scale, choice.mode],
  );
  const query = useHostQuery('render_fea_results', params, analysisCase);
  const next = useMemo(() => feedOf(query, unsolved), [query, unsolved]);
  useEffect(() => {
    setSurface(next);
    return () => setSurface({ status: 'idle', reason: '' });
  }, [next, setSurface]);

  if (analysisCase === undefined) return null;
  const field = resolvedField(analysisCase, choice);
  const title = FIELD_TITLES[field] ?? field;
  if (feed.status === 'ready') {
    const { surface } = feed;
    const range = formatQuantities([surface.min, surface.max], surface.unit);
    return (
      <aside className="analysis-legend" data-testid="analysis-legend" aria-label="Result colour legend">
        <h4 className="analysis-legend__title">
          {title} <span className="analysis-legend__unit">[{range.unit}]</span>
        </h4>
        <p className="analysis-legend__sub">{surface.resultLabel}</p>
        <Ramp surface={surface} />
        <p className="analysis-legend__sub">
          min {range.texts[0]} · max {range.texts[1]}
          {surface.deformationScale > 0 ? ` · deformation ×${surface.deformationScale}` : ''}
        </p>
        {surface.truncated && <p className="analysis-legend__warn">Large model: only part of the surface is painted.</p>}
      </aside>
    );
  }
  const message = feed.status === 'loading' ? 'Painting the result…' : feed.status === 'idle' ? feed.reason : feed.reason;
  return (
    <aside className="analysis-legend analysis-legend--note" data-testid="analysis-legend" role="status">
      {message}
    </aside>
  );
}
