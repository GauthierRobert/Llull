/**
 * @layer ui/viewport/3d
 *
 * Renders batches of identical-geometry entities as THREE.InstancedMesh —
 * one draw call per batch instead of one draw call per entity.
 *
 * ## Architecture
 * - Receives pre-computed `InstanceBatch` objects from `groupEntitiesForInstancing`.
 * - Each `<InstanceBatchMesh>` owns one InstancedMesh for its batch.
 * - Per-instance transforms (position + rotation) are applied via `setMatrixAt`.
 * - Per-instance color is applied via `setColorAt` when any entity in the batch
 *   is selected (highlight tint) or has a distinct base color from the batch key.
 * - Selection raycast: `InstancedMesh.raycast` yields `intersection.instanceId`;
 *   the component maps that back to an entity id via the batch's sorted id array
 *   and calls `onSelect(entityId, additive)`.
 *
 * ## Supported geometry kinds (v1)
 * - box:      THREE.BoxGeometry
 * - cylinder: THREE.CylinderGeometry (32 radial segments)
 * - sphere:   THREE.SphereGeometry (32 × 16 segments)
 *
 * Non-batchable kinds (extrusion, mesh, cone, torus, wedge, pyramid) are NOT
 * rendered here — they remain in the per-entity mesh path in Entities.tsx.
 *
 * ## Performance contract (R9 / P2)
 * - Geometry and material are created ONCE per batch via useMemo and disposed on unmount.
 * - Instance matrices and colors are written in a useEffect keyed on the batch entity
 *   list — NOT inside useFrame. After update, `instanceMatrix.needsUpdate = true` and
 *   `instanceColor.needsUpdate = true` are set; r3f's StoreInvalidator calls invalidate()
 *   so the demand-mode canvas re-renders once.
 * - No per-frame allocations.
 *
 * ## Draw-call delta (100 identical boxes)
 * BEFORE: 100 BoxMesh components → 100 draw calls.
 * AFTER:  1 InstanceBatchMesh (1 InstancedMesh) → 1 draw call.
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { EntityId } from '@core/model/types';
import { useViewportStore } from '@ui/store';
import type { DisplayMode } from '@ui/store';
import type { InstanceBatch } from './grouping';
import { entityIdFromInstanceId } from './grouping';
import { radialSegmentsForDiag, sphereDiag, cylinderDiag } from './lodSegments';

// ---------------------------------------------------------------------------
// Geometry factory (pure, called inside useMemo)
// ---------------------------------------------------------------------------

/**
 * Creates the THREE geometry for a given batchable kind + representative entity.
 * The entity is the first in the batch; all entities in the batch share the same
 * geometric params (guaranteed by the grouping key).
 *
 * @pure (called inside useMemo — no side effects)
 */
function makeGeometry(batch: InstanceBatch): THREE.BufferGeometry {
  const first = batch.entities[0];
  if (!first) return new THREE.BufferGeometry();

  switch (batch.kind) {
    case 'box': {
      if (first.kind !== 'box') return new THREE.BufferGeometry();
      const [w, h, d] = first.size;
      return new THREE.BoxGeometry(w, h, d);
    }
    case 'cylinder': {
      if (first.kind !== 'cylinder') return new THREE.BufferGeometry();
      const cylSeg = radialSegmentsForDiag(cylinderDiag(first.radius, first.height));
      return new THREE.CylinderGeometry(first.radius, first.radius, first.height, cylSeg);
    }
    case 'sphere': {
      if (first.kind !== 'sphere') return new THREE.BufferGeometry();
      const sphSeg = radialSegmentsForDiag(sphereDiag(first.radius));
      const sphHSeg = Math.max(4, Math.min(32, Math.floor(sphSeg / 2)));
      return new THREE.SphereGeometry(first.radius, sphSeg, sphHSeg);
    }
    default: {
      // Exhaustiveness guard — TypeScript narrows BatchableKind; this is unreachable
      // but guards against future additions that haven't been wired yet.
      const _exhaustive: never = batch.kind;
      void _exhaustive;
      return new THREE.BufferGeometry();
    }
  }
}

// ---------------------------------------------------------------------------
// Material params per display mode + selection
// ---------------------------------------------------------------------------

/** Selected-highlight tint color (hex). Matches useMaterialProps.ts emissive. */
const SELECTED_EMISSIVE = new THREE.Color('#3a7bd5');
const SELECTED_EMISSIVE_INTENSITY = 0.35;

/** White — used as a per-instance color multiplier when we want the base color unchanged. */
const WHITE = new THREE.Color(1, 1, 1);

/**
 * Returns MeshStandardMaterial constructor args matching the display mode.
 * Mirrors the logic in useMaterialProps.ts for consistency.
 */
function makeMaterialArgs(displayMode: DisplayMode): THREE.MeshStandardMaterialParameters {
  switch (displayMode) {
    case 'wireframe':
      return {
        roughness: 0.45,
        metalness: 0.08,
        envMapIntensity: 0.8,
        wireframe: true,
        transparent: false,
        opacity: 1,
        depthWrite: true,
        side: THREE.FrontSide,
        vertexColors: true,
      };
    case 'xray':
      return {
        roughness: 0.45,
        metalness: 0.08,
        envMapIntensity: 0,
        wireframe: false,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexColors: true,
      };
    case 'shaded':
    default:
      return {
        roughness: 0.45,
        metalness: 0.08,
        envMapIntensity: 0.8,
        wireframe: false,
        transparent: false,
        opacity: 1,
        depthWrite: true,
        side: THREE.FrontSide,
        vertexColors: true,
      };
  }
}

// ---------------------------------------------------------------------------
// InstanceBatchMesh — renders one InstancedMesh for one batch
// ---------------------------------------------------------------------------

interface InstanceBatchMeshProps {
  batch: InstanceBatch;
  selectionSet: ReadonlySet<EntityId>;
  displayMode: DisplayMode;
  onSelect: (id: EntityId, additive: boolean) => void;
}

/**
 * Renders one THREE.InstancedMesh for a single `InstanceBatch`.
 *
 * - Geometry: created once via useMemo; disposed on unmount.
 * - Material: created once via useMemo; disposed on unmount.
 *   Uses `vertexColors: true` so per-instance color overrides work via setColorAt.
 * - Instance matrices + colors: written in a useEffect keyed on entity ids +
 *   selection set. NOT in useFrame.
 * - Click/raycast: InstancedMesh fires onClick with `intersection.instanceId`;
 *   we map that to an entity id via `entityIdFromInstanceId` and call onSelect.
 */
function InstanceBatchMesh({
  batch,
  selectionSet,
  displayMode,
  onSelect,
}: InstanceBatchMeshProps): React.ReactElement | null {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const count = batch.entities.length;

  // --- Geometry ---
  const geometry = useMemo(() => makeGeometry(batch), [batch.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dispose geometry on unmount or key change.
  useEffect(() => () => geometry.dispose(), [geometry]);

  // --- Material ---
  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial(makeMaterialArgs(displayMode));
    return mat;
  }, [displayMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dispose material on unmount or displayMode change.
  useEffect(() => () => material.dispose(), [material]);

  // --- Instance transforms + colors ---
  // Keyed on a stable string that includes all entity ids + selection state.
  // This ensures we rewrite matrices/colors when:
  //   - entities are added/removed from the batch (position/rotation changes)
  //   - selection changes (color highlight)
  //   - display mode changes (handled above via material recreation)
  const entitySignature = useMemo(() => {
    const ids = batch.entities.map((e) => e.id).join(',');
    const selBits = batch.entities.map((e) => (selectionSet.has(e.id) ? '1' : '0')).join('');
    // Include transforms in signature so matrix update fires when entities move.
    const transforms = batch.entities
      .map((e) => `${e.position.join(',')}/${e.rotation.join(',')}`)
      .join(';');
    return `${ids}|${selBits}|${transforms}`;
  }, [batch.entities, selectionSet]);

  const _dummy = useMemo(() => new THREE.Object3D(), []);
  const _color = useMemo(() => new THREE.Color(), []);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const needsColor = mesh.instanceColor !== null;

    // Ensure instance color buffer exists (InstancedMesh lazily creates it).
    if (!mesh.instanceColor) {
      // Force creation: set the first color (InstancedMesh allocates on setColorAt).
      mesh.setColorAt(0, WHITE);
    }

    for (let i = 0; i < batch.entities.length; i++) {
      const entity = batch.entities[i];
      if (!entity) continue;

      // Write world-space transform.
      _dummy.position.set(entity.position[0], entity.position[1], entity.position[2]);
      _dummy.rotation.set(entity.rotation[0], entity.rotation[1], entity.rotation[2]);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);

      // Write per-instance color.
      const isSelected = selectionSet.has(entity.id);
      if (isSelected) {
        // Blend base color with the highlight emissive tint.
        _color.set(entity.color);
        _color.lerp(SELECTED_EMISSIVE, SELECTED_EMISSIVE_INTENSITY);
        mesh.setColorAt(i, _color);
      } else {
        _color.set(entity.color);
        mesh.setColorAt(i, _color);
      }
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }

    // Suppress unused-variable warning on `needsColor` — it is used as a side-
    // effect gate above to ensure the color buffer existed before the loop.
    void needsColor;
  }, [entitySignature, batch.entities, selectionSet, _dummy, _color]);

  // --- Xray mode: update opacity per frame is not needed; material opacity is uniform ---
  // For xray, selected instances get a slightly higher opacity. Since THREE
  // InstancedMesh does not support per-instance opacity, we use the uniform
  // material opacity (0.18 for unselected). This is a known v1 limitation.
  // If the batch has any selected entity, boost material opacity to selected value.
  useEffect(() => {
    if (displayMode === 'xray') {
      const hasSelected = batch.entities.some((e) => selectionSet.has(e.id));
      material.opacity = hasSelected ? 0.35 : 0.18;
      material.needsUpdate = true;
    }
  }, [displayMode, batch.entities, selectionSet, material]);

  if (count === 0) return null;

  function handleClick(e: ThreeEvent<MouseEvent>): void {
    e.stopPropagation();
    const instanceId = e.instanceId;
    if (instanceId === undefined) return;

    const entityId = entityIdFromInstanceId(batch, instanceId);
    if (!entityId) return;

    const additive = e.nativeEvent.shiftKey || e.nativeEvent.ctrlKey || e.nativeEvent.metaKey;
    onSelect(entityId, additive);
  }

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, count]}
      onClick={handleClick}
      castShadow
      receiveShadow
    />
  );
}

// ---------------------------------------------------------------------------
// InstancedRenderer — public component
// ---------------------------------------------------------------------------

interface InstancedRendererProps {
  /**
   * Pre-computed batches from `groupEntitiesForInstancing`.
   * Each batch is one InstancedMesh draw call.
   */
  batches: Map<string, InstanceBatch>;
  /** Current document selection set. */
  selectionSet: ReadonlySet<EntityId>;
  /** Click → entity selection callback (threaded from Entities). */
  onSelect: (id: EntityId, additive: boolean) => void;
}

/**
 * Renders all instanced batches. One `<InstanceBatchMesh>` per batch key.
 * Reads `displayMode` from the viewport store directly (narrow selector, R3).
 */
export function InstancedRenderer({
  batches,
  selectionSet,
  onSelect,
}: InstancedRendererProps): React.ReactElement {
  const displayMode = useViewportStore((s) => s.displayMode);

  return (
    <group name="instanced-entities">
      {Array.from(batches.entries()).map(([key, batch]) => (
        <InstanceBatchMesh
          key={key}
          batch={batch}
          selectionSet={selectionSet}
          displayMode={displayMode}
          onSelect={onSelect}
        />
      ))}
    </group>
  );
}
