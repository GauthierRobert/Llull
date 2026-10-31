// The footprint / knurl preview of a command being edited (UI-only, never in the document): what the read-only preview query last said, drawn as a ghost on the face.

import { create } from 'zustand';
import type { FootprintView } from '@ui/preview/footprintPreview';

export type FootprintStatus = 'idle' | 'pending' | 'ready' | 'refused';

interface FootprintPreviewState {
  status: FootprintStatus;
  /** The command's own summary (ready) or the reason it is refused, with its code. */
  summary: string;
  view: FootprintView | null;
  set(status: FootprintStatus, summary: string, view: FootprintView | null): void;
  clear(): void;
}

export const useFootprintPreviewStore = create<FootprintPreviewState>()((set) => ({
  status: 'idle',
  summary: '',
  view: null,
  set: (status, summary, view) => set({ status, summary, view }),
  clear: () => set({ status: 'idle', summary: '', view: null }),
}));
