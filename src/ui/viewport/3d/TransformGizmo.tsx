/**
 * @layer ui/viewport/3d
 *
 * Transform gizmo for the single selected 3D entity.
 *
 * drei <TransformControls> attaches to a sibling <group> that is a real scene-graph node (so the
 * "attached object must be part of the scene graph" error never fires). On drag END the delta vs
 * the pre-drag baseline is dispatched as move_entity | rotate_entity | scale_entity — the gizmo
 * NEVER mutates the entity itself (PRIME DIRECTIVE / R1).
 *
 * Feedback-loop prevention: the target group is synced FROM the entity only when the entity or the
 * render origin changes (new selection, or the store update that follows a dispatch). During a drag
 * the gizmo owns the target transform.
 *
 * Scale: `scale_entity` takes one uniform factor — the mean of the gizmo's three scale axes
 * relative to the pre-drag mean. Entity geometry encodes its own size, so the gizmo scale resets
 * to (1,1,1) after each commit.
 *
 * 3D snapping (translate mode, `snap3dEnabled`): a `useFrame` poll runs the pure `snap3d()` against
 * the other entities' key-points while dragging. The nearest snap is kept in a ref and applied at
 * drag end; a SnapIndicator3D marks it. React state changes only when the indicator changes (R9).
 *
 * Demand frameloop: during a drag TransformControls invalidates on every pointer move; when idle
 * this component never invalidates, so the loop quiesces.
 *
 * @affects dispatches move_entity | rotate_entity | scale_entity on drag end
 */

import { useEffect, useRef, useCallback, useState, type MutableRefObject } from 'react';
import { TransformControls } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { TransformControls as TransformControlsImpl } from 'three-stdlib';
import { useStore, useViewportStore } from '@ui/store';
import type { GizmoMode } from '@ui/store';
import { toRenderPosition } from './floatingOrigin';
import { collectSnapCandidates3D, snap3d } from './snap3d';
import type { Snap3DType, SnapPoint3D } from './snap3d';
import { SnapIndicator3D } from './SnapIndicator3D';

// TransformControlsImpl fires a 'dragging-changed' event that is not in
// three.js's Object3DEventMap. We cast the ref to a minimal interface to
// access it without fighting the strict event-map types.
type DraggingDispatcher = {
  addEventListener(type: 'dragging-changed', cb: (event: { value: boolean }) => void): void;
  removeEventListener(type: 'dragging-changed', cb: (event: { value: boolean }) => void): void;
};

/** Tolerance radius (world units) within which a 3D snap candidate is accepted. */
const SNAP3D_TOLERANCE = 0.8;

/** Grid step in world units (matches the viewport Grid cellSize = 1). */
const SNAP3D_GRID_STEP = 1;

type XYZ = Pick<THREE.Vector3, 'x' | 'y' | 'z'>;

/** Component-wise `next - prev`: a translation delta (Vector3) or rotation delta (Euler, radians). */
export function computeDelta(prev: XYZ, next: XYZ): [number, number, number] {
  return [next.x - prev.x, next.y - prev.y, next.z - prev.z];
}

/**
 * Derive a single uniform scale factor from a THREE.Vector3 scale.
 * Uses the arithmetic mean of the three axes.
 */
export function computeScaleFactor(scale: THREE.Vector3): number {
  return (scale.x + scale.y + scale.z) / 3;
}

/** Deltas below this length are drags that did not move anything. */
const MIN_DELTA = 1e-6;

function isNegligible(delta: readonly [number, number, number]): boolean {
  return Math.sqrt(delta[0] ** 2 + delta[1] ** 2 + delta[2] ** 2) < MIN_DELTA;
}

/** Snap marker shown while dragging; `position` is in render space. */
interface Indicator {
  position: readonly [number, number, number];
  type: Snap3DType;
}

const NO_INDICATOR: Indicator = { position: [0, 0, 0], type: 'none' };

interface TransformGizmoProps {
  /** Current transform mode — owned by the parent to share with the overlay. */
  mode: GizmoMode;
  /** Called when dragging starts or stops so the parent can disable OrbitControls. */
  onDraggingChanged: (dragging: boolean) => void;
}

export function TransformGizmo({
  mode,
  onDraggingChanged,
}: TransformGizmoProps): React.ReactElement | null {
  // Narrow selectors (R3). Single-entity selection only; gizmo hidden for 0 or multi-select (v1).
  const selectedId = useStore((s) =>
    s.document.selection.length === 1 ? s.document.selection[0] : undefined,
  );
  const entity = useStore((s) =>
    selectedId === undefined ? undefined : s.document.entities[selectedId],
  );
  const dispatch = useStore((s) => s.dispatch);
  const renderOrigin = useStore((s) => s.renderOrigin);
  const snap3dEnabled = useViewportStore((s) => s.snap3dEnabled);

  // The <group> sibling that TransformControls attaches to.
  const targetRef = useRef<THREE.Group | null>(null);

  // Pre-drag baseline — captured when a drag starts so the delta on drag end is relative to it.
  const preDragPos = useRef<THREE.Vector3>(new THREE.Vector3());
  const preDragRot = useRef<THREE.Euler>(new THREE.Euler());
  const preDragScale = useRef<THREE.Vector3>(new THREE.Vector3(1, 1, 1));

  // The TransformControls instance; it IS a DraggingDispatcher at runtime (cast when wiring events).
  const controlsRef = useRef<TransformControlsImpl>(null);

  const isDraggingRef = useRef(false);
  // Snap candidates: rebuilt when the selection changes and at drag start.
  const snapCandidatesRef = useRef<ReadonlyArray<SnapPoint3D>>([]);
  // Current snap result — updated per-frame, read at drag-end for dispatch.
  const activeSnapRef = useRef<{ x: number; y: number; z: number; type: Snap3DType } | null>(null);

  // Indicator state is pushed to React only when it changes, never per frame; the ref holds the
  // last value pushed.
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

  // Rebuild snap candidates (excluding the selected entity) when the selection changes.
  useEffect(() => {
    snapCandidatesRef.current = collectSnapCandidates3D(useStore.getState().document, selectedId);
  }, [selectedId]);

  // Sync the target group from the entity (new selection, or the store update after a dispatch).
  useEffect(() => {
    const target = targetRef.current;
    if (!entity || !target) return;
    target.position.set(...toRenderPosition(entity.position, renderOrigin));
    target.rotation.set(entity.rotation[0], entity.rotation[1], entity.rotation[2]);
    target.scale.set(1, 1, 1);
    target.updateMatrixWorld(true);
  }, [entity, renderOrigin]);

  // Per-frame snap poll. Does nothing (no setState, no invalidate) unless a snapping translate
  // drag is in progress, so the demand frameloop quiesces when idle.
  useFrame(() => {
    if (!isDraggingRef.current || mode !== 'translate' || !snap3dEnabled) {
      if (indicatorRef.current.type !== 'none') {
        showIndicator({ ...indicatorRef.current, type: 'none' });
      }
      return;
    }

    const target = targetRef.current;
    if (!target) return;
    // target.position is in RENDER space (relative to the floating-origin group); snapping works in world space.
    const result = snap3d(
      target.position.x + renderOrigin[0],
      target.position.y + renderOrigin[1],
      target.position.z + renderOrigin[2],
      snapCandidatesRef.current,
      SNAP3D_TOLERANCE,
      SNAP3D_GRID_STEP,
    );

    // Store for drag-end consumption.
    activeSnapRef.current = result.snapped
      ? { x: result.x, y: result.y, z: result.z, type: result.type }
      : null;

    showIndicator({
      position: [
        result.x - renderOrigin[0],
        result.y - renderOrigin[1],
        result.z - renderOrigin[2],
      ],
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
        // Snapshot the pre-drag baseline and rebuild the candidates from the latest entity state.
        preDragPos.current.copy(target.position);
        preDragRot.current.copy(target.rotation);
        preDragScale.current.copy(target.scale);
        snapCandidatesRef.current = collectSnapCandidates3D(
          useStore.getState().document,
          selectedId,
        );
        activeSnapRef.current = null;
        return;
      }

      showIndicator({ ...indicatorRef.current, type: 'none' });

      if (!selectedId || !target) return;

      if (mode === 'translate') {
        // Apply the snapped position to the gizmo target before computing the delta.
        const snap = activeSnapRef.current;
        if (snap && snap3dEnabled) {
          target.position.set(...toRenderPosition([snap.x, snap.y, snap.z], renderOrigin));
        }
        const delta = computeDelta(preDragPos.current, target.position);
        if (!isNegligible(delta)) dispatch('move_entity', { id: selectedId, delta });
      } else if (mode === 'rotate') {
        const delta = computeDelta(preDragRot.current, target.rotation);
        if (!isNegligible(delta)) dispatch('rotate_entity', { id: selectedId, delta });
      } else {
        // scale — derive the uniform factor relative to the pre-drag scale baseline.
        const prevAvg =
          (preDragScale.current.x + preDragScale.current.y + preDragScale.current.z) / 3;
        const nextFactor = computeScaleFactor(target.scale);
        const factor = prevAvg > 0 ? nextFactor / prevAvg : nextFactor;
        if (Math.abs(factor - 1) < 1e-6 || factor <= 0) return;
        dispatch('scale_entity', { id: selectedId, factor });
        // Reset gizmo scale to neutral; geometry dimensions live in the entity.
        target.scale.set(1, 1, 1);
      }
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
  if (!entity || !selectedId || entity.tags?.includes('bim') === true) return null;

  const [x, y, z] = toRenderPosition(entity.position, renderOrigin);

  return (
    <>
      {/* Sibling pattern: a real scene-graph <group> is the controls' target (see header). */}
      <group
        ref={targetRef}
        position={[x, y, z]}
        rotation={[entity.rotation[0], entity.rotation[1], entity.rotation[2]]}
      />
      <TransformControls
        ref={controlsRef}
        object={targetRef as unknown as MutableRefObject<THREE.Object3D>}
        mode={mode}
        size={0.8}
      />
      {snap3dEnabled && mode === 'translate' && indicator.type !== 'none' && (
        <SnapIndicator3D position={indicator.position} snapType={indicator.type} />
      )}
    </>
  );
}
