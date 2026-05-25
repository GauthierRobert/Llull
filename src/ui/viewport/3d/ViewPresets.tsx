/**
 * @layer ui/viewport/3d
 *
 * ViewPresets — floating overlay buttons for standard 3D view orientations
 * and fit-to-all / fit-to-selection.
 *
 * Presets: Front / Top / Right / Isometric.
 * Fit: Fit All (all entities) / Fit Selection (selected entities only).
 *
 * CRITICAL (P1 carry-forward): under frameloop="demand", any programmatic
 * camera/target change MUST call both invalidate() AND controls.update()
 * to ensure the scene repaints. Without invalidate() the demand loop never
 * fires; without controls.update() the OrbitControls internal state is stale
 * (the U2 RenderOriginSyncer's useFrame relies on these invalidation sources).
 *
 * This component is purely presentational. It reads from the store and
 * never mutates the document (PRIME DIRECTIVE).
 */

import React, { useCallback, useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useStore } from '@ui/store';

// ---------------------------------------------------------------------------
// Geometry helpers (pure — no three.js side-effects)
// ---------------------------------------------------------------------------

interface BoundingBox {
  center: THREE.Vector3;
  radius: number;
}

/**
 * Compute a bounding sphere around all entity positions and derive a camera
 * distance that comfortably frames the whole model.
 *
 * Uses entity positions as proxy for mesh extents (sufficient; mesh half-size
 * is accounted for by the `MESH_HALF_SIZE_ESTIMATE` addend). The final
 * distance is computed as:
 *
 *   distance = (positionSpreadRadius + MESH_HALF_SIZE_ESTIMATE) / tan(halfFov) * margin
 *
 * where halfFov = 37.5° (half of the 75° default PerspectiveCamera fov).
 * This ensures the bounding sphere fits inside the frustum with room to spare.
 *
 * Returns null when there are no entities to frame.
 */

/** Rough estimate of each entity's mesh half-size to add to the position-only radius. */
const MESH_HALF_SIZE_ESTIMATE = 3;
/** Half the default three.js PerspectiveCamera FOV (75°). */
const HALF_FOV_TAN = Math.tan((75 / 2) * (Math.PI / 180)); // tan(37.5°) ≈ 0.767
/** Margin applied on top of the exact fit distance. */
const FIT_MARGIN = 1.35;

function computeSceneBounds(
  entities: Record<string, { position: readonly [number, number, number] }>,
  ids: string[],
): BoundingBox | null {
  if (ids.length === 0) return null;

  const positions = ids
    .map((id) => entities[id]?.position)
    .filter((p): p is readonly [number, number, number] => p !== undefined);

  if (positions.length === 0) return null;

  // Compute centroid.
  const sum = positions.reduce(
    (acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]] as [number, number, number],
    [0, 0, 0] as [number, number, number],
  );
  const center = new THREE.Vector3(
    sum[0] / positions.length,
    sum[1] / positions.length,
    sum[2] / positions.length,
  );

  // Max spread of positions from centroid, with a mesh-half-size addend so
  // a single entity never collapses to radius=0.
  const positionSpread = Math.max(
    0,
    ...positions.map((p) => new THREE.Vector3(p[0], p[1], p[2]).distanceTo(center)),
  );

  const boundingSphereRadius = positionSpread + MESH_HALF_SIZE_ESTIMATE;

  // Camera distance needed to fit the bounding sphere inside the view frustum,
  // accounting for the camera FOV and applying a comfortable margin.
  const radius = (boundingSphereRadius / HALF_FOV_TAN) * FIT_MARGIN;

  return { center, radius };
}

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

type PresetName = 'front' | 'top' | 'right' | 'iso';

interface Preset {
  name: PresetName;
  label: string;
  /** Unit direction of the camera eye RELATIVE to the scene centre. */
  direction: [number, number, number];
}

const PRESETS: Preset[] = [
  { name: 'front', label: 'Front', direction: [0, 0, 1] },
  { name: 'top',   label: 'Top',   direction: [0, 1, 0] },
  { name: 'right', label: 'Right', direction: [1, 0, 0] },
  { name: 'iso',   label: 'Iso',   direction: [1, 1, 1] },
];

// ---------------------------------------------------------------------------
// Inner component (must be inside <Canvas> to access useThree)
// ---------------------------------------------------------------------------

/**
 * Mounted INSIDE the r3f Canvas so it can call useThree().
 * Receives the subset of store state it needs via props to avoid subscribing
 * to the store inside the Canvas (which would re-render the entire tree).
 */
export interface ViewPresetsInnerProps {
  entities: Record<string, { position: readonly [number, number, number] }>;
  selection: string[];
  allEntityIds: string[];
}

export function ViewPresetsInner({
  entities,
  selection,
  allEntityIds,
}: ViewPresetsInnerProps): null {
  // useThree is only valid inside the Canvas — this component is always
  // rendered inside SceneContents.
  const { camera, controls, invalidate } = useThree();

  const applyPreset = useCallback(
    (direction: [number, number, number], target: THREE.Vector3, distance: number) => {
      const orbit = controls as OrbitControlsImpl | null;
      if (!orbit) return;

      const dir = new THREE.Vector3(...direction).normalize();
      const newPos = target.clone().addScaledVector(dir, distance);

      camera.position.copy(newPos);
      camera.lookAt(target);
      orbit.target.copy(target);

      // P1: must call both update() and invalidate() under frameloop="demand".
      // update() syncs OrbitControls internal spherical state; invalidate()
      // queues the next render frame (RenderOriginSyncer depends on this too).
      orbit.update();
      invalidate();
    },
    [camera, controls, invalidate],
  );

  // Expose applyPreset and bounds helpers via a global ref so the outer
  // (non-Canvas) overlay can trigger them via a stable callback mechanism.
  // We use a module-level mutable ref rather than a React ref to avoid the
  // Canvas boundary problem.
  _innerRef.applyPreset = applyPreset;
  _innerRef.entities = entities;
  _innerRef.selection = selection;
  _innerRef.allEntityIds = allEntityIds;

  // Cleanup: null all _innerRef fields on unmount so a stale closure
  // capturing a disposed camera or controls cannot fire after Canvas teardown.
  useEffect(() => {
    return () => {
      _innerRef.applyPreset = null;
      _innerRef.entities = {};
      _innerRef.selection = [];
      _innerRef.allEntityIds = [];
    };
  }, []);

  return null;
}

// Module-level mutable bridge between the inner (Canvas) and outer (DOM) layers.
// This is an intentional architectural exception: r3f does not support portals
// or context across the Canvas boundary. The ref holds ONLY imperative callbacks
// and read-only data — it never mutates the document.
const _innerRef: {
  applyPreset: ((dir: [number, number, number], target: THREE.Vector3, distance: number) => void) | null;
  entities: Record<string, { position: readonly [number, number, number] }>;
  selection: string[];
  allEntityIds: string[];
} = {
  applyPreset: null,
  entities: {},
  selection: [],
  allEntityIds: [],
};

// ---------------------------------------------------------------------------
// Outer overlay (outside the Canvas)
// ---------------------------------------------------------------------------

/**
 * Rendered OUTSIDE the Canvas as a DOM overlay.
 * Reads from the Zustand store via narrow selectors (R3).
 */
export function ViewPresetsOverlay(): React.ReactElement {
  const document = useStore((s) => s.document);
  const selection = document.selection;
  const allIds = document.order;

  // Keep _innerRef in sync whenever store state relevant to fit changes.
  // This is a side-effect-free reference update — no setState.
  _innerRef.entities = document.entities as Record<
    string,
    { position: readonly [number, number, number] }
  >;
  _innerRef.selection = selection;
  _innerRef.allEntityIds = allIds;

  const handlePreset = useCallback((direction: [number, number, number]) => {
    if (!_innerRef.applyPreset) return;
    // Default target: origin, default distance: 10.
    const target = new THREE.Vector3(0, 0, 0);
    _innerRef.applyPreset(direction, target, 10);
  }, []);

  const handleFit = useCallback((ids: string[]) => {
    if (!_innerRef.applyPreset) return;
    const bounds = computeSceneBounds(_innerRef.entities, ids);
    if (!bounds) return;
    // Use the current camera direction (iso) for fit operations.
    _innerRef.applyPreset([1, 1, 1], bounds.center, bounds.radius);
  }, []);

  return (
    <div className="view-presets" aria-label="View presets" role="group">
      {PRESETS.map((preset) => (
        <button
          key={preset.name}
          type="button"
          className="view-preset-btn"
          onClick={() => handlePreset(preset.direction)}
          title={`${preset.label} view`}
          aria-label={`${preset.label} view`}
        >
          {preset.label}
        </button>
      ))}
      <span className="view-preset-divider" aria-hidden="true" />
      <button
        type="button"
        className="view-preset-btn"
        onClick={() => handleFit(allIds)}
        title="Fit all entities into view"
        aria-label="Fit all into view"
      >
        Fit All
      </button>
      <button
        type="button"
        className="view-preset-btn"
        onClick={() => handleFit(selection)}
        title="Fit selected entities into view"
        aria-label="Fit selection into view"
        disabled={selection.length === 0}
      >
        Fit Sel
      </button>
    </div>
  );
}
