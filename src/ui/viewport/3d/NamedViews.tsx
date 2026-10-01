/**
 * @layer ui/viewport/3d
 *
 * NamedViews — savable camera bookmarks for the 3D viewport (EN9).
 *
 * Architecture follows the same Canvas-boundary bridge pattern as ViewPresets:
 *   - `NamedViewsInner` is mounted INSIDE the r3f Canvas (uses `useThree`).
 *     It writes imperative camera callbacks to `_namedViewsRef` so the outer
 *     DOM overlay can drive them across the Canvas boundary.
 *   - `NamedViewsOverlay` is mounted OUTSIDE the Canvas as a DOM overlay.
 *     It reads from `useNamedViewStore` and calls the ref callbacks.
 *
 * CRITICAL (P1 carry-forward): any programmatic camera move MUST call both
 * `controls.update()` AND `invalidate()` under frameloop="demand". Without
 * `invalidate()` the demand loop never fires; without `controls.update()` the
 * OrbitControls internal spherical state is stale and the RenderOriginSyncer
 * useFrame won't see the new target position.
 *
 * This component is purely presentational. It reads from stores and never
 * mutates the document (PRIME DIRECTIVE).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '@ui/store';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useNamedViewStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import type { NamedViewCamera } from '@ui/store';

// ---------------------------------------------------------------------------
// Module-level bridge between inner (Canvas) and outer (DOM) layers.
// Pattern mirrors ViewPresets._innerRef — intentional architectural exception
// for the Canvas boundary (r3f does not support portals/context across it).
// Holds ONLY imperative callbacks — never mutates the document.
// ---------------------------------------------------------------------------

const _namedViewsRef: {
  /** Capture current camera position + target. Returns null if controls not ready. */
  getCameraSnapshot: (() => NamedViewCamera | null) | null;
  /** Drive the OrbitControls to the given position + target, then update + invalidate. */
  applyCamera:
    | ((
        position: readonly [number, number, number],
        target: readonly [number, number, number],
      ) => void)
    | null;
} = {
  getCameraSnapshot: null,
  applyCamera: null,
};

// ---------------------------------------------------------------------------
// Inner component (must be inside <Canvas> to access useThree)
// ---------------------------------------------------------------------------

/**
 * Mounted INSIDE the r3f Canvas so it can call useThree().
 * Writes camera read/write callbacks to _namedViewsRef for the outer overlay.
 */
export function NamedViewsInner(): null {
  const { camera, controls, invalidate } = useThree();

  const getCameraSnapshot = useCallback((): NamedViewCamera | null => {
    const orbit = controls as OrbitControlsImpl | null;
    if (!orbit) return null;
    // Named views are stored in world space; the camera lives in render space.
    const [ox, oy, oz] = useStore.getState().renderOrigin;
    return {
      position: [camera.position.x + ox, camera.position.y + oy, camera.position.z + oz],
      target: [orbit.target.x + ox, orbit.target.y + oy, orbit.target.z + oz],
    };
  }, [camera, controls]);

  const applyCamera = useCallback(
    (
      position: readonly [number, number, number],
      target: readonly [number, number, number],
    ): void => {
      const orbit = controls as OrbitControlsImpl | null;
      if (!orbit) return;

      const [ox, oy, oz] = useStore.getState().renderOrigin;
      const targetVec = new THREE.Vector3(target[0] - ox, target[1] - oy, target[2] - oz);
      camera.position.set(position[0] - ox, position[1] - oy, position[2] - oz);
      camera.lookAt(targetVec);
      orbit.target.copy(targetVec);

      // P1: must call both update() and invalidate() under frameloop="demand".
      // update() syncs OrbitControls internal spherical state; invalidate()
      // queues the next render frame (RenderOriginSyncer depends on this too).
      orbit.update();
      invalidate();
    },
    [camera, controls, invalidate],
  );

  // Write latest callbacks to the bridge ref on every render so closures stay fresh.
  _namedViewsRef.getCameraSnapshot = getCameraSnapshot;
  _namedViewsRef.applyCamera = applyCamera;

  // Cleanup on unmount — prevent stale callbacks from a disposed Canvas firing.
  useEffect(() => {
    return () => {
      _namedViewsRef.getCameraSnapshot = null;
      _namedViewsRef.applyCamera = null;
    };
  }, []);

  return null;
}

// ---------------------------------------------------------------------------
// Outer overlay (outside the Canvas)
// ---------------------------------------------------------------------------

/**
 * Rendered OUTSIDE the Canvas as a DOM overlay.
 * Reads from useNamedViewStore via narrow selectors (R3).
 */
export function NamedViewsOverlay(): React.ReactElement {
  const namedViews = useNamedViewStore((s) => s.namedViews);
  const saveNamedView = useNamedViewStore((s) => s.saveNamedView);
  const restoreNamedView = useNamedViewStore((s) => s.restoreNamedView);
  const deleteNamedView = useNamedViewStore((s) => s.deleteNamedView);

  const [newName, setNewName] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSave = useCallback(() => {
    const trimmed = newName.trim();
    if (trimmed === '') return; // ignore blank names — don't silently create a "View"
    saveNamedView(trimmed, () => _namedViewsRef.getCameraSnapshot?.() ?? null);
    setNewName('');
  }, [newName, saveNamedView]);

  const handleRestore = useCallback(
    (id: string) => {
      restoreNamedView(id, _namedViewsRef.applyCamera ?? null);
    },
    [restoreNamedView],
  );

  const handleDelete = useCallback(
    (id: string) => {
      deleteNamedView(id);
    },
    [deleteNamedView],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') handleSave();
      if (e.key === 'Escape') {
        setNewName('');
        setIsExpanded(false);
      }
    },
    [handleSave],
  );

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => {
      const next = !prev;
      if (next) {
        // Focus the input once the panel expands.
        setTimeout(() => inputRef.current?.focus(), 0);
      }
      return next;
    });
  }, []);

  return (
    <div className="named-views" aria-label="Named camera views" role="group">
      <button
        type="button"
        className={`vp-btn${namedViews.length > 0 ? '' : ' vp-btn--icon'}${isExpanded ? ' vp-btn--toggled' : ''}`}
        onClick={handleToggle}
        aria-expanded={isExpanded}
        aria-controls="named-views-panel"
        aria-label={`Views${namedViews.length > 0 ? ` (${namedViews.length})` : ''}`}
        title="Named views"
      >
        <Icon name="bookmark" size={14} />
        {namedViews.length > 0 && <span className="vp-count">{namedViews.length}</span>}
      </button>

      {isExpanded && (
        <div
          id="named-views-panel"
          className="vp-popover named-views-panel"
          role="region"
          aria-label="Named views panel"
        >
          <div className="named-views-save-row">
            <label className="visually-hidden" htmlFor="named-view-name-input">
              Name
            </label>
            <input
              id="named-view-name-input"
              ref={inputRef}
              type="text"
              className="named-views-input"
              placeholder="Name this view…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={handleKeyDown}
              aria-label="New view name"
              maxLength={64}
            />
            <button
              type="button"
              className="vp-primary-btn"
              onClick={handleSave}
              aria-label="Save current camera as named view"
              title="Save current camera"
            >
              Save
            </button>
          </div>

          {namedViews.length > 0 ? (
            <ul className="named-views-list" role="list" aria-label="Saved views">
              {namedViews.map((view) => (
                <li key={view.id} className="named-views-item">
                  <button
                    type="button"
                    className="named-views-restore-btn"
                    onClick={() => handleRestore(view.id)}
                    title={`Restore view: ${view.name}`}
                    aria-label={`Restore view ${view.name}`}
                  >
                    {view.name}
                  </button>
                  <button
                    type="button"
                    className="named-views-delete-btn"
                    onClick={() => handleDelete(view.id)}
                    title={`Delete view: ${view.name}`}
                    aria-label={`Delete view ${view.name}`}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="named-views-empty">No saved views yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
