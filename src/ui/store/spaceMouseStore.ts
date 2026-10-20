// 3D mouse presentation state: connection status and the per-viewer settings (invert, speed, dominant axis), persisted in localStorage.

import { create } from 'zustand';
import { DEFAULT_SETTINGS, type SpaceMouseSettings, sanitizeSettings } from '@ui/input/spaceMouseMapping';
import { readStored, writeStored } from './persistence';

export const SPACE_MOUSE_STORAGE_KEY = 'llull-spacemouse';

type SpaceMouseStatus = 'idle' | 'connected' | 'error';

interface SpaceMouseState {
  settings: SpaceMouseSettings;
  status: SpaceMouseStatus;
  deviceName: string | null;
  message: string | null;
  updateSettings(patch: Partial<SpaceMouseSettings>): void;
  resetSettings(): void;
  setConnection(status: SpaceMouseStatus, deviceName?: string | null, message?: string | null): void;
}

export const useSpaceMouseStore = create<SpaceMouseState>()((set, get) => {
  const save = (settings: SpaceMouseSettings): void => {
    writeStored(SPACE_MOUSE_STORAGE_KEY, settings);
    set({ settings });
  };
  return {
    settings: sanitizeSettings(readStored(SPACE_MOUSE_STORAGE_KEY)),
    status: 'idle',
    deviceName: null,
    message: null,
    updateSettings: (patch) => save(sanitizeSettings({ ...get().settings, ...patch })),
    resetSettings: () => save(DEFAULT_SETTINGS),
    setConnection: (status, deviceName = null, message = null) => set({ status, deviceName, message }),
  };
});
