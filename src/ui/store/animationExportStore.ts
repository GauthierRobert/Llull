// Whether the "Export animation…" dialog is open (UI-only, never serialized). Opened from the transport bar and the Physics panel.

import { create } from 'zustand';

interface AnimationExportState {
  open: boolean;
  setOpen(open: boolean): void;
}

export const useAnimationExportStore = create<AnimationExportState>()((set) => ({ open: false, setOpen: (open) => set({ open }) }));
