// Presentation state of the paper-space viewer: which sheet is open, the picked view, the dimensions toggle.

import { create } from 'zustand';

interface SheetViewState {
  openSheetId: string | null;
  selectedViewId: string | null;
  showDimensions: boolean;
  openSheet: (sheetId: string) => void;
  closeSheet: () => void;
  selectView: (viewId: string | null) => void;
  setShowDimensions: (show: boolean) => void;
}

export const useSheetViewStore = create<SheetViewState>((set) => ({
  openSheetId: null,
  selectedViewId: null,
  showDimensions: false,
  openSheet: (sheetId) => set({ openSheetId: sheetId, selectedViewId: null }),
  closeSheet: () => set({ openSheetId: null, selectedViewId: null }),
  selectView: (viewId) => set({ selectedViewId: viewId }),
  setShowDimensions: (showDimensions) => set({ showDimensions }),
}));
