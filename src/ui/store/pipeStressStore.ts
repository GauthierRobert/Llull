// What the pipe stress review shows (UI-only, not persisted): the model under review, the load case the overlay paints (null = worst of all)
// and whether the overlay is drawn. Set by the pipe stress panel.

import { create } from 'zustand';

interface PipeStressState {
  modelId: string | null;
  caseName: string | null;
  shown: boolean;
  setModelId(modelId: string | null): void;
  setCaseName(caseName: string | null): void;
  setShown(shown: boolean): void;
}

export const usePipeStressStore = create<PipeStressState>()((set) => ({
  modelId: null,
  caseName: null,
  shown: false,
  setModelId: (modelId) => set({ modelId, caseName: null }),
  setCaseName: (caseName) => set({ caseName }),
  setShown: (shown) => set({ shown }),
}));
