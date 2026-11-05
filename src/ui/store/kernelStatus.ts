// Geometry kernel state (UI-only): the renderer kernel's load state (set by src/main.tsx) and whether the backend's exact kernel is
// unavailable (`/health` kernelStatus, or a command result whose provenance says the mesh kernel answered). Shown in the StatusBar.

import { create } from 'zustand';

type KernelStatus = 'loading' | 'ready' | 'failed';

interface KernelStatusState {
  status: KernelStatus;
  /** Why the backend answers on the mesh kernel while the exact kernel was requested (FR-INT-07); null = nothing degraded. */
  degradedReason: string | null;
  setStatus(status: KernelStatus): void;
  setDegradedReason(reason: string | null): void;
}

export const useKernelStatusStore = create<KernelStatusState>()((set) => ({
  status: 'loading',
  degradedReason: null,
  setStatus: (status) => set({ status }),
  setDegradedReason: (degradedReason) => set({ degradedReason }),
}));
