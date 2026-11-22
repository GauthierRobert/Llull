// One component batch (component x child solid) as up to three InstancedMeshes, one per LOD tier (full mesh, decimated mesh, bounding
// box). Every instance lives in exactly one tier; matrices and colours are copied from master arrays when the tiers change (camera
// crossing a screen-size threshold, throttled in useFrame, never a React render). Picking goes through the instance BVH and maps
// tier slot -> instance index -> entity id; hover repaints two instances imperatively.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { solidTriangles } from '@core/geometry/solidTriangles';
import type { Entity, EntityId, Material, Vec3 } from '@core/model/types';
import { type DisplayMode, useStore } from '@ui/store';
import { useTintStore } from '@ui/store/tintStore';
import { isAdditiveSelect } from '../../selectClick';
import { useDisposable } from '../../useDisposable';
import { XRAY_OPACITY } from '../../viewportPalette';
import { buildTriangleSoupGeometry } from '../entities/meshSolidGeometry';
import { makeMaterialArgs, useBatchCapacity } from '../InstancedRenderer';
import { bucketRaycast } from '../plant/plantPick';
import { planCameraOf } from '../plant/plantPlanCamera';
import { isClippedAway } from '../review/activeClipPlanes';
import type { ComponentBatch } from '../componentInstancePlan';
import { paintInstance, masterColours } from './componentColours';
import { COMPONENT_LOD_MIN_INSTANCES, assignTiers, packTiers, type TierPacking } from './componentLod';
import { buildBoxGeometry, buildCoarseGeometry } from './componentLodGeometry';
import { buildPickIndex, instanceMatrices, localBoxOf, worldBoxes } from './componentPick';
import { createThrottle } from './hoverThrottle';

/** Pointer-move work (one raycast result -> two repaints) runs at most this often. */
const HOVER_INTERVAL_MS = 33;
/** The camera is re-evaluated against the LOD thresholds at most this often (seconds). */
const LOD_INTERVAL_S = 0.1;
const TIERS = [0, 1, 2] as const;

export interface BatchMeshProps {
  batch: ComponentBatch;
  entities: Readonly<Record<EntityId, Entity>>;
  materials: Readonly<Record<string, Material>>;
  displayMode: DisplayMode;
  selectionSet: ReadonlySet<EntityId>;
  onSelect: (id: EntityId, additive: boolean) => void;
}

/** What the imperative paths read; replaced as a whole when the data changes. */
interface TierState {
  matrices: Float32Array;
  colours: Float32Array;
  boxes: Float64Array;
  rayQuery: (origin: Vec3, direction: Vec3) => number[];
  tiers: Uint8Array;
  packing: TierPacking;
  hovered: number;
  lastCamera: string;
  sinceLod: number;
}

function sameTiers(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((tier, index) => tier === b[index]);
}

function disposable<T extends THREE.BufferGeometry | undefined>(geometry: T): { dispose: () => void; geometry: T } {
  return { geometry, dispose: () => geometry?.dispose() };
}

export function ComponentBatchMesh({
  batch,
  entities,
  materials,
  displayMode,
  selectionSet,
  onSelect,
}: BatchMeshProps): React.ReactElement | null {
  const tints = useTintStore((s) => s.tints);
  const count = batch.ids.length;
  const capacity = useBatchCapacity(count);
  const material = batch.child.materialId === undefined ? undefined : materials[batch.child.materialId];
  const lodOn = count >= COMPONENT_LOD_MIN_INSTANCES;

  const geometry = useDisposable(() => buildTriangleSoupGeometry(solidTriangles(batch.child)) ?? new THREE.BufferGeometry(), [batch.child]);
  const coarse = useDisposable(() => disposable(lodOn ? buildCoarseGeometry(batch.child) : undefined), [batch.child, lodOn]).geometry;
  const boxGeometry = useDisposable(() => disposable(lodOn ? buildBoxGeometry(geometry) : undefined), [geometry, lodOn]).geometry;
  const surface = useDisposable(() => new THREE.MeshStandardMaterial(makeMaterialArgs(displayMode, material)), [displayMode, material]);

  // Narrow phase (three-mesh-bvh) on every tier geometry; the broad phase is the instance BVH below.
  useEffect(() => {
    const built = [geometry, coarse, boxGeometry].filter((g): g is THREE.BufferGeometry => g !== undefined);
    for (const g of built) if (typeof g.computeBoundsTree === 'function') g.computeBoundsTree();
    return () => {
      for (const g of built) if (typeof g.disposeBoundsTree === 'function') g.disposeBoundsTree();
    };
  }, [geometry, coarse, boxGeometry]);

  const meshRefs = useRef<(THREE.InstancedMesh | null)[]>([null, null, null]);
  const stateRef = useRef<TierState | null>(null);

  const matrices = useMemo(() => instanceMatrices(batch.ids, entities), [batch.ids, entities]);
  const boxes = useMemo(() => worldBoxes(matrices, localBoxOf(geometry)), [matrices, geometry]);
  const pickIndex = useMemo(() => buildPickIndex(boxes), [boxes]);
  const colours = useMemo(
    () => masterColours(batch.ids, entities, material?.color ?? batch.child.color, selectionSet, tints),
    [batch, entities, material, selectionSet, tints],
  );

  const repack = useCallback((): void => {
    const state = stateRef.current;
    if (state === null) return;
    state.packing = packTiers(state.tiers);
    for (const tier of TIERS) {
      const mesh = meshRefs.current[tier];
      if (!mesh) continue;
      const members = state.packing.members[tier];
      const array = mesh.instanceMatrix.array as Float32Array;
      members.forEach((index, slot) => {
        array.set(state.matrices.subarray(index * 16, index * 16 + 16), slot * 16);
        paintInstance(mesh, slot, state.colours, index, index === state.hovered);
      });
      mesh.count = members.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (members.length > 0) {
        mesh.computeBoundingSphere();
        mesh.computeBoundingBox();
      }
      mesh.raycast = bucketRaycast({ members }, (origin, direction) => state.rayQuery(origin, direction));
    }
  }, []);

  // New data: every instance back at tier 0 until the camera says otherwise, then copied into the meshes.
  useEffect(() => {
    const previous = stateRef.current;
    stateRef.current = {
      matrices,
      colours,
      boxes,
      rayQuery: (origin, direction) => pickIndex.rayQuery(origin, direction),
      tiers: new Uint8Array(count),
      packing: { members: [[], [], []], slot: new Int32Array(count) },
      hovered: previous !== null && previous.hovered < count ? previous.hovered : -1,
      lastCamera: '',
      sinceLod: LOD_INTERVAL_S,
    };
    repack();
  }, [matrices, colours, boxes, pickIndex, count, repack, geometry, surface, capacity, coarse, boxGeometry]);

  useFrame((frame, delta) => {
    const state = stateRef.current;
    if (!lodOn || state === null) return;
    state.sinceLod += delta;
    if (state.sinceLod < LOD_INTERVAL_S) return;
    state.sinceLod = 0;
    const camera = planCameraOf(frame.camera, useStore.getState().renderOrigin, frame.size.width, frame.size.height);
    if (camera === null) return;
    const signature = [...camera.eye, ...camera.direction, camera.fovDeg, camera.viewHeight, camera.heightPx].join(',');
    if (signature === state.lastCamera) return;
    state.lastCamera = signature;
    const next = assignTiers(state.boxes, camera, state.tiers, coarse !== undefined);
    if (sameTiers(next, state.tiers)) return;
    state.tiers = next;
    repack();
    frame.invalidate();
  });

  useEffect(() => {
    if (displayMode !== 'xray') return;
    surface.opacity = batch.ids.some((id) => selectionSet.has(id)) ? XRAY_OPACITY.selected : XRAY_OPACITY.idle;
    surface.needsUpdate = true;
  }, [displayMode, batch.ids, selectionSet, surface]);

  const applyHover = useCallback((index: number): void => {
    const state = stateRef.current;
    if (state === null || state.hovered === index) return;
    const previous = state.hovered;
    state.hovered = index;
    for (const touched of [previous, index]) {
      const mesh = meshRefs.current[state.tiers[touched] ?? 0];
      if (touched >= 0 && mesh) paintInstance(mesh, state.packing.slot[touched] ?? 0, state.colours, touched, touched === index);
    }
  }, []);
  const hover = useMemo(() => createThrottle<number>(applyHover, HOVER_INTERVAL_MS), [applyHover]);
  useEffect(() => () => hover.cancel(), [hover]);

  const handlers = useMemo(
    () =>
      TIERS.map((tier) => {
        /** Instance index of a hit on this tier's mesh (same slot -> index map as picking). */
        const indexOf = (event: ThreeEvent<PointerEvent | MouseEvent>): number | undefined =>
          event.instanceId === undefined ? undefined : stateRef.current?.packing.members[tier][event.instanceId];
        return {
          onClick(event: ThreeEvent<MouseEvent>): void {
            if (isClippedAway(event.point)) return;
            event.stopPropagation();
            const index = indexOf(event);
            const id = index === undefined ? undefined : batch.ids[index];
            if (id !== undefined) onSelect(id, isAdditiveSelect(event.nativeEvent));
          },
          onPointerMove(event: ThreeEvent<PointerEvent>): void {
            hover.push(isClippedAway(event.point) ? -1 : (indexOf(event) ?? -1));
          },
          onPointerOut(): void {
            hover.cancel();
            applyHover(-1);
          },
        };
      }),
    [batch.ids, onSelect, hover, applyHover],
  );

  if (count === 0) return null;
  const tierGeometry = [geometry, coarse, boxGeometry];
  return (
    <>
      {TIERS.map((tier) => {
        const tierGeom = tierGeometry[tier];
        const handler = handlers[tier];
        if (tierGeom === undefined || handler === undefined) return null;
        return (
          <instancedMesh
            key={tier}
            ref={(mesh: THREE.InstancedMesh | null) => void (meshRefs.current[tier] = mesh)}
            args={[tierGeom, surface, capacity]}
            userData={{ instanceIds: batch.ids, lodTier: tier }}
            onClick={handler.onClick}
            onPointerMove={handler.onPointerMove}
            onPointerOut={handler.onPointerOut}
            castShadow={tier === 0}
            receiveShadow={tier === 0}
          />
        );
      })}
    </>
  );
}
