// Geometry kernel load state (UI-only), set by the composition root (src/main.tsx), shown in the StatusBar.

import { create } from 'zustand';

type KernelStatus = 'loading' | 'ready' | 'failed';

interface KernelStatusState {
  status: KernelStatus;
  setStatus(status: KernelStatus): void;
}

export const useKernelStatusStore = create<KernelStatusState>()((set) => ({ status: 'loading', setStatus: (status) => set({ status }) }));
