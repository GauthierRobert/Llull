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
 * - cylinder/sphere: shared +Z-up builders from entities/primitiveGeometry (same as single meshes)
 *
 * Non-batchable kinds (extrusion, mesh, cone, torus, wedge, pyramid) are NOT
 * rendered here — they remain in the per-entity mesh path in Entities.tsx.
 *
 * ## Performance contract (R9)
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
import { buildCylinderGeometry, buildSphereGeometry } from './entities/primitiveGeometry';

/**
 * Creates the THREE geometry for a given batchable kind + representative entity.
 * The entity is the first in the batch; all entities in the batch share the same
 * geometric params (guaranteed by the grouping key).
 *
 * @pure (called inside useMemo — no side effects)
 */
export function makeGeometry(batch: InstanceBatch): THREE.BufferGeometry {
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
      return buildCylinderGeometry(first.radius, first.height);
    }
    case 'sphere': {
      if (first.kind !== 'sphere') return new THREE.BufferGeometry();
      return buildSphereGeometry(first.radius);
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

/** Selected-highlight tint color (hex). Matches useMaterialProps.ts emissive. */
const SELECTED_EMISSIVE = new THREE.Color('#3a7bd5');
const SELECTED_EMISSIVE_INTENSITY = 0.35;

/** White — used as a per-instance color multiplier when we want the base color unchanged. */
const WHITE = new THREE.Color(1, 1, 1);

/**
 * Returns MeshStandardMaterial constructor args matching the display mode.
 * Mirrors the logic in useMaterialProps.ts for consistency.
 *
 * `batchMaterial` carries optional PBR overrides from an assigned document material.
 * The overrides are applied in shaded mode only — wireframe and x-ray ignore them.
 */
export function makeMaterialArgs(
  displayMode: DisplayMode,
  batchMaterial?: { roughness: number; metalness: number } | undefined,
): THREE.MeshStandardMaterialParameters {
  // In shaded mode, use batch-level PBR values when available.
  const roughness = displayMode === 'shaded' && batchMaterial ? batchMaterial.roughness : 0.45;
  const metalness = displayMode === 'shaded' && batchMaterial ? batchMaterial.metalness : 0.08;

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
      };
    case 'shaded':
    default:
      return {
        roughness,
        metalness,
        envMapIntensity: 0.8,
        wireframe: false,
        transparent: false,
        opacity: 1,
        depthWrite: true,
        side: THREE.FrontSide,
      };
  }
}

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
 *   Per-instance colors come from `instanceColor` (setColorAt); `vertexColors` stays
 *   off — primitive geometries carry no color attribute, so enabling it renders black.
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

  // batch objects are rebuilt every grouping pass; batch.key is the content identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geometry = useMemo(() => makeGeometry(batch), [batch.key]);

  // Dispose geometry on unmount or key change.
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Uses batch.pbrMaterial for roughness/metalness in shaded mode.
  const material = useMemo(
    () => new THREE.MeshStandardMaterial(makeMaterialArgs(displayMode, batch.pbrMaterial)),
    [displayMode, batch.pbrMaterial],
  );

  // Dispose material on unmount or displayMode change.
  useEffect(() => () => material.dispose(), [material]);

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
    // Include batch material color so instance colors update when material changes.
    const matColor = batch.pbrMaterial?.color ?? '';
    return `${ids}|${selBits}|${transforms}|${matColor}`;
  }, [batch.entities, selectionSet, batch.pbrMaterial]);

  const _dummy = useMemo(() => new THREE.Object3D(), []);
  const _color = useMemo(() => new THREE.Color(), []);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

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
      // In shaded mode with an assigned material, use the material's diffuse color.
      // Otherwise fall back to the entity's own color.
      // Selection highlight blends on top of whichever base color is active.
      const baseColor = batch.pbrMaterial ? batch.pbrMaterial.color : entity.color;
      _color.set(baseColor);
      if (selectionSet.has(entity.id)) _color.lerp(SELECTED_EMISSIVE, SELECTED_EMISSIVE_INTENSITY);
      mesh.setColorAt(i, _color);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }
  }, [entitySignature, batch.entities, batch.pbrMaterial, selectionSet, _dummy, _color]);

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
