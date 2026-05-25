/**
 * @layer ui/store
 *
 * Named-view store — camera bookmarks for the 3D viewport.
 *
 * Stores a list of user-named camera positions (position + target).
 * Persists to localStorage so bookmarks survive page reloads — guards
 * for unavailable storage (sandboxed iframes, test environments).
 *
 * This is UI-only presentation state, intentionally NOT part of CadDocument
 * (no Lane-1 model change required — see EN9 notes). Named views hold only
 * camera position/target; they do not encode document content.
 *
 * PRIME DIRECTIVE: no document mutations ever happen here.
 */

import { create } from 'zustand';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal camera bookmark: eye position + orbit target in world space. */
export interface NamedViewCamera {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
}

/** A saved camera bookmark. */
export interface NamedView {
  /** Stable unique id (timestamp-based, not entity id — scoped to this store). */
  readonly id: string;
  /** Human-readable label given by the user. */
  name: string;
  /** Camera state captured at save time. */
  camera: NamedViewCamera;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'llull-named-views';

function readStoredViews(): NamedView[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Basic shape validation — discard malformed entries.
    return parsed.filter(
      (v): v is NamedView =>
        typeof v === 'object' &&
        v !== null &&
        typeof (v as Record<string, unknown>)['id'] === 'string' &&
        typeof (v as Record<string, unknown>)['name'] === 'string' &&
        typeof (v as Record<string, unknown>)['camera'] === 'object',
    );
  } catch {
    // localStorage unavailable or JSON malformed — start fresh.
    return [];
  }
}

function persistViews(views: NamedView[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
  } catch {
    // ignore — storage quota exceeded or unavailable
  }
}

function generateId(): string {
  return `nv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// Store state
// ---------------------------------------------------------------------------

export interface NamedViewStoreState {
  /** Current list of saved named views, in creation order. */
  namedViews: NamedView[];

  /**
   * Capture the current camera and save it as a named view.
   * `getCameraSnapshot` is a callback injected by the inner Canvas component
   * (via the bridge ref) that returns the live camera position and target.
   * Returns the new view's id, or null if the snapshot could not be captured.
   */
  saveNamedView(
    name: string,
    getCameraSnapshot: () => NamedViewCamera | null,
  ): string | null;

  /**
   * Restore a previously saved named view by id.
   * `applyCamera` is a callback injected by the inner Canvas component
   * that drives OrbitControls + calls update() + invalidate() (P1 carry-forward).
   * No-ops silently if the id is not found or the callback is unavailable.
   */
  restoreNamedView(
    id: string,
    applyCamera: ((position: readonly [number, number, number], target: readonly [number, number, number]) => void) | null,
  ): void;

  /**
   * Delete a saved named view by id. No-op if the id is not found.
   */
  deleteNamedView(id: string): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useNamedViewStore = create<NamedViewStoreState>()((set, get) => ({
  namedViews: readStoredViews(),

  saveNamedView(
    name: string,
    getCameraSnapshot: () => NamedViewCamera | null,
  ): string | null {
    const snapshot = getCameraSnapshot();
    if (!snapshot) return null;

    const newView: NamedView = {
      id: generateId(),
      name: name.trim() || 'View',
      camera: snapshot,
    };

    set((state) => {
      const next = [...state.namedViews, newView];
      persistViews(next);
      return { namedViews: next };
    });

    return newView.id;
  },

  restoreNamedView(
    id: string,
    applyCamera: ((position: readonly [number, number, number], target: readonly [number, number, number]) => void) | null,
  ): void {
    if (!applyCamera) return;
    const view = get().namedViews.find((v) => v.id === id);
    if (!view) return;
    applyCamera(view.camera.position, view.camera.target);
  },

  deleteNamedView(id: string): void {
    set((state) => {
      const next = state.namedViews.filter((v) => v.id !== id);
      persistViews(next);
      return { namedViews: next };
    });
  },
}));
