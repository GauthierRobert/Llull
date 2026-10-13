// User-named 3D camera bookmarks persisted to localStorage; UI-only, never in the CadDocument.

import { create } from 'zustand';
import { isRecord } from '@lib/isRecord';
import { readStored, writeStored } from './persistence';

export interface NamedViewCamera {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
}

interface NamedView {
  /** Timestamp-based, scoped to this store. */
  readonly id: string;
  name: string;
  camera: NamedViewCamera;
}

const STORAGE_KEY = 'llull-named-views';

function readStoredViews(): NamedView[] {
  const stored = readStored(STORAGE_KEY);
  return Array.isArray(stored)
    ? stored.filter(
        (view): view is NamedView =>
          isRecord(view) && typeof view.id === 'string' && typeof view.name === 'string' && typeof view.camera === 'object',
      )
    : [];
}

function generateId(): string {
  return `nv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

type ApplyCamera = (position: readonly [number, number, number], target: readonly [number, number, number]) => void;

interface NamedViewStoreState {
  namedViews: NamedView[];

  /** Camera from `getCameraSnapshot` (injected by the in-Canvas component); null id when it cannot be captured. */
  saveNamedView(name: string, getCameraSnapshot: () => NamedViewCamera | null): string | null;

  /** Applies through `applyCamera` (drives OrbitControls); no-op for an unknown id or missing callback. */
  restoreNamedView(id: string, applyCamera: ApplyCamera | null): void;

  deleteNamedView(id: string): void;
}

export const useNamedViewStore = create<NamedViewStoreState>()((set, get) => ({
  namedViews: readStoredViews(),

  saveNamedView(name: string, getCameraSnapshot: () => NamedViewCamera | null): string | null {
    const snapshot = getCameraSnapshot();
    if (!snapshot) return null;

    const newView: NamedView = { id: generateId(), name: name.trim() || 'View', camera: snapshot };

    set((state) => {
      const next = [...state.namedViews, newView];
      writeStored(STORAGE_KEY, next);
      return { namedViews: next };
    });

    return newView.id;
  },

  restoreNamedView(id: string, applyCamera: ApplyCamera | null): void {
    if (!applyCamera) return;
    const view = get().namedViews.find((v) => v.id === id);
    if (!view) return;
    applyCamera(view.camera.position, view.camera.target);
  },

  deleteNamedView(id: string): void {
    set((state) => {
      const next = state.namedViews.filter((v) => v.id !== id);
      writeStored(STORAGE_KEY, next);
      return { namedViews: next };
    });
  },
}));
