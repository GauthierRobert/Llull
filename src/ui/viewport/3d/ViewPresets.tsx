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
import type { Vec3 } from '@core/model/types';
import { ORIGIN, add3 } from '@lib/vec3';
import { useStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { NamedViewsOverlay } from './NamedViews';
import { toRenderPosition } from './floatingOrigin';
import { PRESET_DIRECTIONS, type PresetDirection, type PresetName } from './viewPresetDirections';

type EntityPositions = Record<string, { position: Vec3 }>;

/** Rough estimate of each entity's mesh half-size to add to the position-only radius. */
const MESH_HALF_SIZE_ESTIMATE = 3;
/** Half the default three.js PerspectiveCamera FOV (75°). */
const HALF_FOV_TAN = Math.tan((75 / 2) * (Math.PI / 180)); // tan(37.5°) ≈ 0.767
/** Margin applied on top of the exact fit distance. */
const FIT_MARGIN = 1.35;

/**
 * Framing for `ids`: the centroid of their positions and the camera distance that fits a
 * bounding sphere (position spread + MESH_HALF_SIZE_ESTIMATE) inside the frustum with
 * FIT_MARGIN to spare. Entity positions stand in for mesh extents.
 *
 * @failure no ids, or none with a known position -> null
 */
function computeSceneBounds(
  entities: EntityPositions,
  ids: string[],
): { center: THREE.Vector3; radius: number } | null {
  const positions = ids
    .map((id) => entities[id]?.position)
    .filter((p): p is Vec3 => p !== undefined);
  if (positions.length === 0) return null;

  const sum = positions.reduce(add3, ORIGIN);
  const center = new THREE.Vector3(
    sum[0] / positions.length,
    sum[1] / positions.length,
    sum[2] / positions.length,
  );

  // Max spread of positions from the centroid, plus a mesh-half-size addend so a single entity
  // never collapses to radius 0.
  const positionSpread = Math.max(
    0,
    ...positions.map((p) => new THREE.Vector3(p[0], p[1], p[2]).distanceTo(center)),
  );
  const boundingSphereRadius = positionSpread + MESH_HALF_SIZE_ESTIMATE;

  // Camera distance that fits the bounding sphere in the frustum, with a comfortable margin.
  return { center, radius: (boundingSphereRadius / HALF_FOV_TAN) * FIT_MARGIN };
}

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

  const fit = (ids: string[]): void => {
    const bounds = computeSceneBounds(useStore.getState().document.entities, ids);
    if (bounds) bridge.applyPreset?.(PRESET_DIRECTIONS.iso, bounds.center, bounds.radius);
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
              // Look at the origin from distance 10.
              onClick={() => bridge.applyPreset?.(PRESET_DIRECTIONS[name], new THREE.Vector3(), 10)}
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
