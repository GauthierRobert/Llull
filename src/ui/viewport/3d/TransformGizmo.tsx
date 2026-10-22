/**
 * Gizmo for the sole selected 3D entity. TransformControls drives a sibling scene-graph <group>; on drag END the
 * delta vs the pre-drag baseline is dispatched as move_entities | rotate_entity | scale_entity (never mutated, R1).
 * The group syncs FROM the entity only on entity/render-origin change, so the gizmo owns it mid-drag (no feedback loop).
 * Scale = mean of the 3 axes vs the pre-drag mean, reset to 1 after commit (geometry carries size).
 * Translate snapping polls `snap3d` in useFrame, kept in a ref and applied at drag end; React state changes only when
 * the indicator does, and nothing invalidates while idle (demand frameloop).
 */

import { useEffect, useRef, useCallback, useState, type MutableRefObject } from 'react';
import { TransformControls } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { TransformControls as TransformControlsImpl } from 'three-stdlib';
import { type GizmoMode, useStore, useViewportStore } from '@ui/store';
import { useSoleSelectedEntity } from '@ui/store/selectionHooks';
import { toRenderPosition } from './floatingOrigin';
import { type Snap3DType, type SnapPoint3D, collectSnapCandidates3D, snap3d } from './snap3d';
import { SnapIndicator3D } from './SnapIndicator3D';
import { gizmoDragCommit, snapBackHint } from './gizmoCommit';
import { useDirectEditStore } from '@ui/store/directEditStore';

// 'dragging-changed' is not in Object3DEventMap.
type DraggingDispatcher = {
  addEventListener(type: 'dragging-changed', cb: (event: { value: boolean }) => void): void;
  removeEventListener(type: 'dragging-changed', cb: (event: { value: boolean }) => void): void;
};

const SNAP3D_TOLERANCE = 0.8;

/** Matches the viewport Grid cellSize. */
const SNAP3D_GRID_STEP = 1;

interface Indicator {
  position: readonly [number, number, number];
  type: Snap3DType;
}

const NO_INDICATOR: Indicator = { position: [0, 0, 0], type: 'none' };

export function TransformGizmo({
  mode,
  onDraggingChanged,
}: {
  mode: GizmoMode;
  onDraggingChanged: (dragging: boolean) => void;
}): React.ReactElement | null {
  // Hidden for 0 or multi-select.
  const entity = useSoleSelectedEntity();
  const selectedId = entity?.id;
  const dispatch = useStore((s) => s.dispatch);
  const renderOrigin = useStore((s) => s.renderOrigin);
  const snap3dEnabled = useViewportStore((s) => s.snap3dEnabled);
  const editingCage = useDirectEditStore((s) => s.entityId !== null && s.entityId === selectedId);
  const onLockedLayer = useStore((s) => entity !== undefined && s.document.layers[entity.layerId]?.locked === true);

  const targetRef = useRef<THREE.Group | null>(null);

  const preDragPos = useRef<THREE.Vector3>(new THREE.Vector3());
  const preDragRot = useRef<THREE.Euler>(new THREE.Euler());
  const preDragScale = useRef<THREE.Vector3>(new THREE.Vector3(1, 1, 1));

  const controlsRef = useRef<TransformControlsImpl>(null);
  const isDraggingRef = useRef(false);

  // Rebuilt on selection change and at drag start.
  const snapCandidatesRef = useRef<ReadonlyArray<SnapPoint3D>>([]);
  const activeSnapRef = useRef<{ x: number; y: number; z: number; type: Snap3DType } | null>(null);

  // Pushed to React only on change; the ref holds the last value pushed.
  const [indicator, setIndicator] = useState<Indicator>(NO_INDICATOR);
  const indicatorRef = useRef<Indicator>(NO_INDICATOR);
  const showIndicator = useCallback((next: Indicator) => {
    const last = indicatorRef.current;
    if (
      next.type === last.type &&
      next.position[0] === last.position[0] &&
      next.position[1] === last.position[1] &&
      next.position[2] === last.position[2]
    ) {
      return;
    }
    indicatorRef.current = next;
    setIndicator(next);
  }, []);

  // Drag start rebuilds again, so document edits never leave a drag stale.
  useEffect(() => {
    snapCandidatesRef.current = collectSnapCandidates3D(useStore.getState().document, selectedId);
  }, [selectedId]);

  useEffect(() => {
    const target = targetRef.current;
    if (!entity || !target) return;
    target.position.set(...toRenderPosition(entity.position, renderOrigin));
    target.rotation.set(entity.rotation[0], entity.rotation[1], entity.rotation[2]);
    target.scale.set(1, 1, 1);
    target.updateMatrixWorld(true);
  }, [entity, renderOrigin]);

  // No setState / invalidate unless a snapping translate drag is running.
  useFrame(() => {
    if (!isDraggingRef.current || mode !== 'translate' || !snap3dEnabled) {
      if (indicatorRef.current.type !== 'none') {
        showIndicator({ ...indicatorRef.current, type: 'none' });
      }
      return;
    }

    const target = targetRef.current;
    if (!target) return;
    // target is in RENDER space (floating origin); snapping works in world space.
    const result = snap3d(
      target.position.x + renderOrigin[0],
      target.position.y + renderOrigin[1],
      target.position.z + renderOrigin[2],
      snapCandidatesRef.current,
      SNAP3D_TOLERANCE,
      SNAP3D_GRID_STEP,
    );

    activeSnapRef.current = result.snapped ? { x: result.x, y: result.y, z: result.z, type: result.type } : null;

    showIndicator({
      position: [result.x - renderOrigin[0], result.y - renderOrigin[1], result.z - renderOrigin[2]],
      type: result.snapped ? result.type : 'none',
    });
  });

  const handleDraggingChanged = useCallback(
    (event: { value: boolean }) => {
      const dragging = event.value;
      onDraggingChanged(dragging);
      isDraggingRef.current = dragging;
      const target = targetRef.current;

      if (dragging) {
        if (!target) return;
        preDragPos.current.copy(target.position);
        preDragRot.current.copy(target.rotation);
        preDragScale.current.copy(target.scale);
        snapCandidatesRef.current = collectSnapCandidates3D(useStore.getState().document, selectedId);
        activeSnapRef.current = null;
        return;
      }

      showIndicator({ ...indicatorRef.current, type: 'none' });

      if (!selectedId || !target) return;

      const rawEnd = target.position.clone();
      let snapApplied = false;
      if (mode === 'translate') {
        const snap = activeSnapRef.current;
        if (snap && snap3dEnabled) {
          target.position.set(...toRenderPosition([snap.x, snap.y, snap.z], renderOrigin));
          snapApplied = true;
        }
      }
      const commit = gizmoDragCommit(
        mode,
        selectedId,
        { position: preDragPos.current, rotation: preDragRot.current, scale: preDragScale.current },
        { position: target.position, rotation: target.rotation, scale: target.scale },
      );
      if (commit !== null) dispatch(commit.name, commit.params);
      else if (mode === 'translate') {
        const hint = snapBackHint(preDragPos.current, rawEnd, false, snapApplied, SNAP3D_GRID_STEP, useStore.getState().document.units);
        if (hint !== null) useStore.getState().setStatusMessage(hint);
      }
      if (mode === 'scale') target.scale.set(1, 1, 1);
    },
    [selectedId, mode, dispatch, onDraggingChanged, snap3dEnabled, renderOrigin, showIndicator],
  );

  useEffect(() => {
    const controls = controlsRef.current as (DraggingDispatcher & TransformControlsImpl) | null;
    if (!controls) return;
    controls.addEventListener('dragging-changed', handleDraggingChanged);
    return () => controls.removeEventListener('dragging-changed', handleDraggingChanged);
  }, [handleDraggingChanged]);

  // Generated building geometry is edited through its element (Building panel), not the gizmo.
  if (!entity || editingCage || onLockedLayer || entity.tags?.includes('bim') === true) return null;

  const [x, y, z] = toRenderPosition(entity.position, renderOrigin);

  return (
    <>
      <group ref={targetRef} position={[x, y, z]} rotation={entity.rotation} />
      <TransformControls ref={controlsRef} object={targetRef as unknown as MutableRefObject<THREE.Object3D>} mode={mode} size={0.8} />
      {snap3dEnabled && mode === 'translate' && indicator.type !== 'none' && (
        <SnapIndicator3D position={indicator.position} snapType={indicator.type} />
      )}
    </>
  );
}
