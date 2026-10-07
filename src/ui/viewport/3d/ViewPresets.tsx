/**
 * @layer ui/viewport/3d
 *
 * ViewPresets — floating overlay buttons for standard 3D view orientations (Front / Top / Right /
 * Iso) and fit-to-all / fit-to-selection.
 *
 * CRITICAL: under frameloop="demand", any programmatic camera/target change MUST call both
 * invalidate() AND controls.update(). Without invalidate() the demand loop never fires; without
 * controls.update() the OrbitControls internal state is stale (the RenderOriginSyncer's useFrame
 * relies on these invalidation sources).
 *
 * Purely presentational: reads the store and never mutates the document (PRIME DIRECTIVE).
 */

import React, { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { NamedViewsOverlay } from './NamedViews';
import { computeFitFraming } from './fitBounds';
import { toRenderPosition } from './floatingOrigin';
import { PRESET_DIRECTIONS, type PresetDirection, type PresetName } from './viewPresetDirections';

const PRESETS: ReadonlyArray<{ name: PresetName; label: string }> = [
  { name: 'front', label: 'Front' },
  { name: 'top', label: 'Top' },
  { name: 'right', label: 'Right' },
  { name: 'iso', label: 'Iso' },
];

type ApplyPreset = (direction: PresetDirection, target: THREE.Vector3, distance: number) => void;

// Module-level bridge between the inner (Canvas) and outer (DOM) layers: r3f has no portals or
// context across the Canvas boundary. Holds ONLY the camera driver registered by
// ViewPresetsInner; it never touches the document.
const bridge: { applyPreset: ApplyPreset | null } = { applyPreset: null };

/** Mounted INSIDE the r3f Canvas (useThree); registers the camera driver for the overlay. */
export function ViewPresetsInner(): null {
  const { camera, controls, invalidate } = useThree();

  useEffect(() => {
    bridge.applyPreset = (direction, target, distance) => {
      const orbit = controls as OrbitControlsImpl | null;
      if (!orbit) return;

      const dir = new THREE.Vector3(direction[0], direction[1], direction[2]).normalize();
      // `target` is world space; the camera lives in render space (world − renderOrigin).
      const renderTarget = new THREE.Vector3(
        ...toRenderPosition([target.x, target.y, target.z], useStore.getState().renderOrigin),
      );

      camera.up.set(0, 0, 1);
      camera.position.copy(renderTarget.clone().addScaledVector(dir, distance));
      camera.lookAt(renderTarget);
      orbit.target.copy(renderTarget);

      // Must call both update() and invalidate() under frameloop="demand".
      orbit.update();
      invalidate();
    };
    // Unregister on unmount so a stale closure over a disposed camera cannot fire after teardown.
    return () => {
      bridge.applyPreset = null;
    };
  }, [camera, controls, invalidate]);

  return null;
}

/** Rendered OUTSIDE the Canvas as a DOM overlay. */
export function ViewPresetsOverlay(): React.ReactElement {
  const selection = useStore((s) => s.document.selection);
  const allEntityIds = useStore((s) => s.document.order);

  /** View `ids` from `direction`, framed to fit; nothing to frame -> origin from distance 10. */
  const frame = (direction: PresetDirection, ids: string[]): void => {
    const framing = computeFitFraming(useStore.getState().document, ids);
    if (!framing) {
      bridge.applyPreset?.(direction, new THREE.Vector3(), 10);
      return;
    }
    const [x, y, z] = framing.center;
    bridge.applyPreset?.(direction, new THREE.Vector3(x, y, z), framing.distance);
  };
  const fit = (ids: string[]): void => {
    if (ids.length > 0) frame(PRESET_DIRECTIONS.iso, ids);
  };

  return (
    <div className="vp-overlay vp-overlay--top-right">
      <div className="vp-toolbar" aria-label="View presets" role="group">
        <div className="vp-group">
          {PRESETS.map(({ name, label }) => (
            <button
              key={name}
              type="button"
              className="vp-btn"
              onClick={() => frame(PRESET_DIRECTIONS[name], allEntityIds)}
              title={`${label} view`}
              aria-label={`${label} view`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="vp-divider" aria-hidden="true" />
        <div className="vp-group">
          <button
            type="button"
            className="vp-btn vp-btn--icon"
            onClick={() => fit(allEntityIds)}
            title="Fit all entities into view"
            aria-label="Fit all into view"
          >
            <Icon name="fit" size={14} />
          </button>
          <button
            type="button"
            className="vp-btn vp-btn--icon"
            onClick={() => fit(selection)}
            title="Fit selected entities into view"
            aria-label="Fit selection into view"
            disabled={selection.length === 0}
          >
            <Icon name="cursor" size={14} />
          </button>
        </div>
        <span className="vp-divider" aria-hidden="true" />
        <NamedViewsOverlay />
      </div>
    </div>
  );
}
