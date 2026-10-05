/**
 * @layer ui/viewport/3d
 *
 * NamedViews — savable camera bookmarks for the 3D viewport.
 *
 * Same Canvas-boundary bridge pattern as ViewPresets:
 *   - `NamedViewsInner` is mounted INSIDE the r3f Canvas (uses `useThree`) and registers
 *     imperative camera callbacks in `bridge` so the DOM overlay can drive them.
 *   - `NamedViewsOverlay` is mounted OUTSIDE the Canvas; it reads `useNamedViewStore` and calls
 *     the bridge callbacks.
 *
 * CRITICAL: any programmatic camera move MUST call both `controls.update()` AND `invalidate()`
 * under frameloop="demand". Without `invalidate()` the demand loop never fires; without
 * `controls.update()` the OrbitControls internal spherical state is stale and the
 * RenderOriginSyncer useFrame won't see the new target position.
 *
 * Purely presentational: reads stores and never mutates the document (PRIME DIRECTIVE).
 */

import React, { useEffect, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useNamedViewStore, useStore } from '@ui/store';
import type { NamedViewCamera } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { toRenderPosition } from './floatingOrigin';

// Module-level bridge between the inner (Canvas) and outer (DOM) layers — r3f has no portals or
// context across the Canvas boundary. Holds ONLY imperative callbacks, never the document.
const bridge: {
  /** Capture current camera position + target. */
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

/** Mounted INSIDE the r3f Canvas so it can call useThree(); registers the bridge callbacks. */
export function NamedViewsInner(): null {
  const { camera, controls, invalidate } = useThree();

  useEffect(() => {
    const orbit = controls as OrbitControlsImpl | null;
    // Named views are stored in world space; the camera lives in render space.
    bridge.getCameraSnapshot = () => {
      if (!orbit) return null;
      const [ox, oy, oz] = useStore.getState().renderOrigin;
      return {
        position: [camera.position.x + ox, camera.position.y + oy, camera.position.z + oz],
        target: [orbit.target.x + ox, orbit.target.y + oy, orbit.target.z + oz],
      };
    };
    bridge.applyCamera = (position, target) => {
      if (!orbit) return;
      const { renderOrigin } = useStore.getState();
      const targetVec = new THREE.Vector3(...toRenderPosition(target, renderOrigin));
      camera.position.set(...toRenderPosition(position, renderOrigin));
      camera.lookAt(targetVec);
      orbit.target.copy(targetVec);

      // Must call both update() and invalidate() under frameloop="demand".
      orbit.update();
      invalidate();
    };
    // Unregister on unmount so stale callbacks from a disposed Canvas cannot fire.
    return () => {
      bridge.getCameraSnapshot = null;
      bridge.applyCamera = null;
    };
  }, [camera, controls, invalidate]);

  return null;
}

/** Rendered OUTSIDE the Canvas as a DOM overlay. */
export function NamedViewsOverlay(): React.ReactElement {
  const namedViews = useNamedViewStore((s) => s.namedViews);
  const saveNamedView = useNamedViewStore((s) => s.saveNamedView);
  const restoreNamedView = useNamedViewStore((s) => s.restoreNamedView);
  const deleteNamedView = useNamedViewStore((s) => s.deleteNamedView);

  const [newName, setNewName] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the name field once the panel opens.
  useEffect(() => {
    if (isExpanded) inputRef.current?.focus();
  }, [isExpanded]);

  const handleSave = (): void => {
    const trimmed = newName.trim();
    if (trimmed === '') return; // ignore blank names — don't silently create a "View"
    saveNamedView(trimmed, () => bridge.getCameraSnapshot?.() ?? null);
    setNewName('');
  };

  return (
    <div className="named-views" aria-label="Named camera views" role="group">
      <button
        type="button"
        className={`vp-btn${namedViews.length > 0 ? '' : ' vp-btn--icon'}${isExpanded ? ' vp-btn--toggled' : ''}`}
        onClick={() => setIsExpanded((expanded) => !expanded)}
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
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
                if (e.key === 'Escape') {
                  setNewName('');
                  setIsExpanded(false);
                }
              }}
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
                    onClick={() => restoreNamedView(view.id, bridge.applyCamera ?? null)}
                    title={`Restore view: ${view.name}`}
                    aria-label={`Restore view ${view.name}`}
                  >
                    {view.name}
                  </button>
                  <button
                    type="button"
                    className="named-views-delete-btn"
                    onClick={() => deleteNamedView(view.id)}
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
