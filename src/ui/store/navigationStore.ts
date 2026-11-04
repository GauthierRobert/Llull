// How the 3D camera is driven (UI-only, not persisted, never a command): orbit (the default OrbitControls), first-person walk or free fly.

import { create } from 'zustand';
import type { NavigationMode } from '@ui/viewport/3d/navigation/navigationMath';

interface NavigationState {
  mode: NavigationMode;
  setMode(mode: NavigationMode): void;
}

export const useNavigationStore = create<NavigationState>()((set) => ({ mode: 'orbit', setMode: (mode) => set({ mode }) }));
