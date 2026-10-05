/**
 * @layer ui/store
 *
 * Named-view store — user-named camera bookmarks (position + target) for the 3D viewport,
 * persisted to localStorage. UI-only presentation state, intentionally NOT part of CadDocument.
 *
 * PRIME DIRECTIVE: no document mutations ever happen here.
 */

import { create } from 'zustand';
import { isRecord } from '@lib/isRecord';
import { readStored, writeStored } from './persistence';

/** Minimal camera bookmark: eye position + orbit target in world space. */
export interface NamedViewCamera {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
}

/** A saved camera bookmark. */
interface NamedView {
  /** Stable unique id (timestamp-based, not entity id — scoped to this store). */
  readonly id: string;
  /** Human-readable label given by the user. */
  name: string;
  /** Camera state captured at save time. */
  camera: NamedViewCamera;
}

const STORAGE_KEY = 'llull-named-views';

function readStoredViews(): NamedView[] {
  const stored = readStored(STORAGE_KEY);
  // Basic shape validation — discard malformed entries.
  return Array.isArray(stored)
    ? stored.filter(
        (view): view is NamedView =>
          isRecord(view) &&
          typeof view.id === 'string' &&
          typeof view.name === 'string' &&
          typeof view.camera === 'object',
      )
    : [];
}

function generateId(): string {
  return `nv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

type ApplyCamera = (
  position: readonly [number, number, number],
  target: readonly [number, number, number],
) => void;

interface NamedViewStoreState {
  /** Saved named views, in creation order. */
  namedViews: NamedView[];

  /**
   * Save the camera returned by `getCameraSnapshot` (injected by the inner Canvas component) as a
   * named view. Returns the new view's id, or null if the snapshot could not be captured.
   */
  saveNamedView(name: string, getCameraSnapshot: () => NamedViewCamera | null): string | null;

  /**
   * Restore a saved view through `applyCamera` (injected by the inner Canvas component; drives
   * OrbitControls). No-op if the id is not found or the callback is unavailable.
   */
  restoreNamedView(id: string, applyCamera: ApplyCamera | null): void;

  /** Delete a saved named view by id. No-op if the id is not found. */
  deleteNamedView(id: string): void;
}

export const useNamedViewStore = create<NamedViewStoreState>()((set, get) => ({
  namedViews: readStoredViews(),

  saveNamedView(name: string, getCameraSnapshot: () => NamedViewCamera | null): string | null {
    const snapshot = getCameraSnapshot();
    if (!snapshot) return null;

    const newView: NamedView = {
      id: generateId(),
      name: name.trim() || 'View',
      camera: snapshot,
    };

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
