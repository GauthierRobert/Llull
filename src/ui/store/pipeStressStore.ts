// What the pipe stress review shows (UI-only, not persisted): the model under review, the load case the overlay paints (null = worst of all),
// whether the overlay is drawn, whether the support reaction arrows are drawn and the deformed-shape scale (0 = undeformed; needs a case).
// Set by the pipe stress panel.

import { create } from 'zustand';

interface PipeStressState {
  modelId: string | null;
  caseName: string | null;
  shown: boolean;
  showReactions: boolean;
  deformScale: number;
  setModelId(modelId: string | null): void;
  setCaseName(caseName: string | null): void;
  setShown(shown: boolean): void;
  setShowReactions(showReactions: boolean): void;
  setDeformScale(deformScale: number): void;
}

export const usePipeStressStore = create<PipeStressState>()((set) => ({
  modelId: null,
  caseName: null,
  shown: false,
  showReactions: true,
  deformScale: 0,
  setModelId: (modelId) => set({ modelId, caseName: null }),
  setCaseName: (caseName) => set({ caseName }),
  setShown: (shown) => set({ shown }),
  setShowReactions: (showReactions) => set({ showReactions }),
  setDeformScale: (deformScale) => set({ deformScale }),
}));
