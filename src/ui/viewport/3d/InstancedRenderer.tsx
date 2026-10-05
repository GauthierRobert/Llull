/**
 * @layer ui/viewport/3d
 *
 * Renders batches of identical-geometry entities (box / cylinder / sphere, see grouping.ts) as
 * one THREE.InstancedMesh per batch — one draw call instead of one per entity. Everything else
 * stays on the per-entity mesh path in Entities.tsx.
 *
 * - Geometry and material are created once per batch and disposed on unmount (R9).
 * - Instance matrices and colors are written in an effect keyed on the batch contents (not in
 *   useFrame) and flagged `needsUpdate`; per-instance color carries the selection tint.
 * - Click: `InstancedMesh.raycast` yields `instanceId`, mapped back to an entity id through the
 *   batch's id-sorted entity array.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { EntityId } from '@core/model/types';
import { useViewportStore } from '@ui/store';
import type { DisplayMode } from '@ui/store';
import type { InstanceBatch } from './grouping';
import { entityIdFromInstanceId } from './grouping';
import { buildCylinderGeometry, buildSphereGeometry } from './entities/primitiveGeometry';
import { useDisposable } from '../useDisposable';

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

/** Scratch objects reused by every batch's matrix/color writes (single-threaded, synchronous). */
const DUMMY = new THREE.Object3D();
const SCRATCH_COLOR = new THREE.Color();

const SHADED_MATERIAL_ARGS: THREE.MeshStandardMaterialParameters = {
  roughness: 0.45,
  metalness: 0.08,
  envMapIntensity: 0.8,
  wireframe: false,
  transparent: false,
  opacity: 1,
  depthWrite: true,
  side: THREE.FrontSide,
};

/**
 * MeshStandardMaterial constructor args for the display mode (mirrors useMaterialProps.ts).
 * `batchMaterial` carries optional PBR overrides from an assigned document material; they apply
 * in shaded mode only — wireframe and x-ray ignore them.
 */
export function makeMaterialArgs(
  displayMode: DisplayMode,
  batchMaterial?: { roughness: number; metalness: number } | undefined,
): THREE.MeshStandardMaterialParameters {
  switch (displayMode) {
    case 'wireframe':
      return { ...SHADED_MATERIAL_ARGS, wireframe: true };
    case 'xray':
      return {
        ...SHADED_MATERIAL_ARGS,
        envMapIntensity: 0,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
        side: THREE.DoubleSide,
      };
    case 'shaded':
    default:
      return {
        ...SHADED_MATERIAL_ARGS,
        ...(batchMaterial && {
          roughness: batchMaterial.roughness,
          metalness: batchMaterial.metalness,
        }),
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
 * Renders one THREE.InstancedMesh for a single `InstanceBatch`. Per-instance colors come from
 * `instanceColor` (setColorAt); `vertexColors` stays off — primitive geometries carry no color
 * attribute, so enabling it renders black.
 */
function InstanceBatchMesh({
  batch,
  selectionSet,
  displayMode,
  onSelect,
}: InstanceBatchMeshProps): React.ReactElement | null {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const count = batch.entities.length;

  // Batch objects are rebuilt every grouping pass; batch.key is the content identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geometry = useDisposable(() => makeGeometry(batch), [batch.key]);

  // Uses batch.pbrMaterial for roughness/metalness in shaded mode.
  const material = useDisposable(
    () => new THREE.MeshStandardMaterial(makeMaterialArgs(displayMode, batch.pbrMaterial)),
    [displayMode, batch.pbrMaterial],
  );

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // Ensure instance color buffer exists (InstancedMesh lazily creates it).
    if (!mesh.instanceColor) {
      // Force creation: set the first color (InstancedMesh allocates on setColorAt).
      mesh.setColorAt(0, WHITE);
    }

    batch.entities.forEach((entity, i) => {
      // Write world-space transform.
      DUMMY.position.set(entity.position[0], entity.position[1], entity.position[2]);
      DUMMY.rotation.set(entity.rotation[0], entity.rotation[1], entity.rotation[2]);
      DUMMY.updateMatrix();
      mesh.setMatrixAt(i, DUMMY.matrix);

      // Write per-instance color.
      // In shaded mode with an assigned material, use the material's diffuse color.
      // Otherwise fall back to the entity's own color.
      // Selection highlight blends on top of whichever base color is active.
      SCRATCH_COLOR.set(batch.pbrMaterial ? batch.pbrMaterial.color : entity.color);
      if (selectionSet.has(entity.id)) {
        SCRATCH_COLOR.lerp(SELECTED_EMISSIVE, SELECTED_EMISSIVE_INTENSITY);
      }
      mesh.setColorAt(i, SCRATCH_COLOR);
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [batch.entities, batch.pbrMaterial, selectionSet]);

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
