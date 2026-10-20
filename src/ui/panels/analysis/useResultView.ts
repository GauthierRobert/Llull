// Records the plotted result on the case: set_result_view for the fields it accepts (the view store stays the overlay's live copy),
// and seeds the selector from the case's recorded `view`.

import { useEffect, useRef } from 'react';
import type { AnalysisCase } from '@core/model/analysis';
import { useStore } from '@ui/store';
import { resultViewParams } from './analysisFields';
import { useAnalysisViewStore } from './analysisViewStore';

/** Dispatch set_result_view for the current choice (call right after updating the view store). */
export function recordResultView(analysisCase: AnalysisCase): void {
  const params = resultViewParams(analysisCase, useAnalysisViewStore.getState());
  if (params !== null) useStore.getState().dispatch('set_result_view', params, { quiet: true });
}

/** Once the case is the one drawn on the model and the selector is untouched, load the recorded view into the view store. */
export function useSeedResultView(analysisCase: AnalysisCase): void {
  const active = useAnalysisViewStore((s) => s.analysisId === analysisCase.id && s.field === null);
  const seeded = useRef(false);
  const { view } = analysisCase;
  useEffect(() => {
    if (seeded.current || !active) return;
    seeded.current = true;
    if (view === undefined) return;
    const state = useAnalysisViewStore.getState();
    state.setField(view.field);
    if (view.loadCase !== undefined) state.setLoadCase(view.loadCase);
    if (view.mode !== undefined) state.setMode(view.mode);
    state.setScale(String(view.deformationScale));
  }, [active, view]);
}
