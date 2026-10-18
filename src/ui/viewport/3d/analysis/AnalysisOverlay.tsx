// The Analysis panel's case on the model (inside the floating-origin group): supports, loads, thermal BCs, probes, result extremes and the
// painted result surface. Visible while the Analysis panel is open and "Show on model" is on; the item picked in the panel is emphasised.

import React, { useMemo } from 'react';
import '@ui/styles/panels/analysisOverlay.css';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { useFocusStore } from '@ui/store/focusStore';
import { buildSetupItems } from '@ui/panels/analysis/analysisItems';
import { useAnalysisViewStore } from '@ui/panels/analysis/analysisViewStore';
import { ItemGlyphs } from './AnalysisGlyphs';
import { ResultSurface } from './ResultSurface';

const DIMMED = 0.3;

export function AnalysisOverlay(): React.ReactElement | null {
  const document = useDocumentWithoutSelection();
  const analysisId = useAnalysisViewStore((s) => s.analysisId);
  const showOnModel = useAnalysisViewStore((s) => s.showOnModel);
  const feed = useAnalysisViewStore((s) => s.surface);
  const focusKey = useFocusStore((s) => s.focus?.key ?? null);
  const analysisCase = analysisId === null ? undefined : document.analysis?.cases[analysisId];
  const items = useMemo(() => (analysisCase === undefined ? null : buildSetupItems(document, analysisCase)), [document, analysisCase]);
  if (!showOnModel || items === null) return null;
  const emphasis = focusKey !== null && focusKey.startsWith('analysis:');
  const drawn = [...items.constraints, ...items.loads, ...items.thermal, ...items.probes, ...items.extremes];
  return (
    <group name="analysis-overlay">
      {feed.status === 'ready' && <ResultSurface surface={feed.surface} />}
      {drawn.map((item) => {
        const dimmed = emphasis && focusKey !== item.key;
        return <ItemGlyphs key={item.key} item={item} size={items.size} opacity={dimmed ? DIMMED : 0.95} labelled={!dimmed} />;
      })}
    </group>
  );
}
