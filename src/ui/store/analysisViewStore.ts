// The analysis case the Analysis panel is showing (UI-only, never serialized): the viewport draws that case's supports, loads and
// probes on the model while the panel is open. Null = no case focused, nothing drawn.

import { create } from 'zustand';

interface AnalysisViewState {
  focusedAnalysisId: string | null;
  focusAnalysis: (analysisId: string | null) => void;
}

export const useAnalysisViewStore = create<AnalysisViewState>((set) => ({
  focusedAnalysisId: null,
  focusAnalysis: (focusedAnalysisId) => set({ focusedAnalysisId }),
}));
