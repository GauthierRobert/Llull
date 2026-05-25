/**
 * @layer ui/viewport/3d
 *
 * Transform gizmo for the selected 3D entity.
 *
 * Attaches drei <TransformControls> to a dummy Object3D target whose transform
 * is initialised from the selected entity each time selection changes. On drag
 * END the component computes the delta vs the entity's stored transform and
 * dispatches the appropriate command — it NEVER mutates the entity directly
 * (PRIME DIRECTIVE / R1).
 *
 * Feedback-loop prevention
 * ─────────────────────────
 * The dummy target is only synced FROM the entity store at two safe moments:
 *   1. When the selected entity id changes (new selection).
 *   2. After a dispatch completes (store updates → entity has new transform).
 * During a drag the store is read-only from the gizmo's perspective; the gizmo
 * owns the target transform. After dispatch the store update re-flows through
 * React → the entity's stored position/rotation is the new baseline → the
 * target is reset to that baseline → ready for the next drag.
 *
 * Scale → uniform factor
 * ──────────────────────
 * `scale_entity` accepts a single uniform factor. We derive it as the arithmetic
 * mean of the gizmo's three scale axes after drag end. The entity geometry
 * encodes its own size so the gizmo scale resets to (1,1,1) after each commit.
 *
 * Mode state
 * ──────────
 * `mode` is owned by the parent (Viewport3D) so the overlay toggle and the
 * in-Canvas gizmo share the same value without prop-drilling through the Canvas.
 *
 * 3D Snapping (translate mode only)
 * ──────────────────────────────────
 * When `snap3dEnabled` is true and mode is 'translate', a `useFrame` poll
 * reads the live gizmo target position each frame and runs `snap3d()` against
 * scene entity key-points. The nearest snap (within tolerance) is stored in a
 * ref so `handleDraggingChanged` can apply it at drag-end. A `SnapIndicator3D`
 * marker is rendered at the snapped position during the drag.
 * This keeps all snap math in the pure `snap3d.ts` helper (unit-tested) and
 * avoids per-frame `setState` (R9).
 *
 * Demand-mode invalidation
 * ─────────────────────────
 * During a drag, `useFrame` runs on every frame (OrbitControls are disabled and
 * TransformControls calls invalidate() on each pointer-move). The
 * `SnapIndicator3D` also calls `invalidate()` on mount/unmount to ensure the
 * indicator appears and disappears cleanly.
 *
 * @affects dispatches move_entity | rotate_entity | scale_entity on drag end
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { TransformControls } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { TransformControls as TransformControlsImpl } from 'three-stdlib';
import { useStore } from '@ui/store';
import { useViewportStore } from '@ui/store';
import type { Entity } from '@core/model/types';
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

// ---------------------------------------------------------------------------
// Gizmo mode type (exported so Viewport3D can share it)
// ---------------------------------------------------------------------------

export type GizmoMode = 'translate' | 'rotate' | 'scale';

// ---------------------------------------------------------------------------
// Snap constants
// ---------------------------------------------------------------------------

/** Tolerance radius (world units) within which a 3D snap candidate is accepted. */
const SNAP3D_TOLERANCE = 0.8;

/** Grid step in world units (matches the viewport Grid cellSize = 1). */
const SNAP3D_GRID_STEP = 1;

// ---------------------------------------------------------------------------
// Pure delta helpers — exported for optional unit tests
// ---------------------------------------------------------------------------

/** Compute the translation delta between two world positions. */
export function computeTranslateDelta(
  prev: THREE.Vector3,
  next: THREE.Vector3,
): [number, number, number] {
  return [next.x - prev.x, next.y - prev.y, next.z - prev.z];
}

/** Compute the rotation delta between two Euler angles (radians). */
export function computeRotateDelta(
  prev: THREE.Euler,
  next: THREE.Euler,
): [number, number, number] {
  return [next.x - prev.x, next.y - prev.y, next.z - prev.z];
}

/**
 * Derive a single uniform scale factor from a THREE.Vector3 scale.
 * Uses the arithmetic mean of the three axes.
 */
export function computeScaleFactor(scale: THREE.Vector3): number {
  return (scale.x + scale.y + scale.z) / 3;
}

// ---------------------------------------------------------------------------
// TransformGizmo
// ---------------------------------------------------------------------------

interface TransformGizmoProps {
  /** Current transform mode — owned by the parent to share with the overlay. */
  mode: GizmoMode;
  /** Called when dragging starts or stops so the parent can disable OrbitControls. */
  onDraggingChanged: (dragging: boolean) => void;
}

export function TransformGizmo({ mode, onDraggingChanged }: TransformGizmoProps): React.ReactElement | null {
  // Narrow selectors (R3).
  const selection = useStore((s) => s.document.selection);
  const entities = useStore((s) => s.document.entities);
  const dispatch = useStore((s) => s.dispatch);
  const renderOrigin = useStore((s) => s.renderOrigin);
  const snap3dEnabled = useViewportStore((s) => s.snap3dEnabled);

  // Single-entity selection only; gizmo hidden for 0 or multi-select (v1).
  const selectedId = selection.length === 1 ? selection[0] : undefined;
  const entity: Entity | undefined = selectedId != null ? entities[selectedId] : undefined;

  // The dummy Object3D that TransformControls attaches to.
  // We imperatively set its transform; drei then renders the gizmo around it.
  const targetRef = useRef<THREE.Object3D>(new THREE.Object3D());

  // Pre-drag baseline — captured in the dragging-changed → true handler so
  // the delta on drag end is always relative to where the drag started.
  const preDragPos = useRef<THREE.Vector3>(new THREE.Vector3());
  const preDragRot = useRef<THREE.Euler>(new THREE.Euler());
  const preDragScale = useRef<THREE.Vector3>(new THREE.Vector3(1, 1, 1));

  // Ref to the TransformControls instance. TransformControlsImpl extends Object3D
  // and IS a DraggingDispatcher at runtime; we cast when wiring events.
  const controlsRef = useRef<TransformControlsImpl>(null);

  // ---- Snap state (refs for per-frame work, no setState per frame) ----
  const isDraggingRef = useRef(false);
  // Snap candidates: rebuilt when entities change (or selection changes).
  const snapCandidatesRef = useRef<ReadonlyArray<SnapPoint3D>>([]);
  // Current snap result — updated per-frame, read at drag-end for dispatch.
  const activeSnapRef = useRef<{ x: number; y: number; z: number; type: Snap3DType } | null>(null);

  // Indicator state: React state is fine here because it updates only on snap
  // type/position changes — not every frame (activeSnapRef drives the decision).
  const [indicatorPos, setIndicatorPos] = useState<readonly [number, number, number]>([0, 0, 0]);
  const [indicatorType, setIndicatorType] = useState<Snap3DType>('none');

  // Cached indicator pos ref to avoid duplicate setState calls.
  const prevIndicatorPosRef = useRef<readonly [number, number, number]>([0, 0, 0]);
  const prevIndicatorTypeRef = useRef<Snap3DType>('none');

  // ---- Rebuild snap candidates when the selection changes (excluding self).
  // Candidates are also rebuilt at drag-start (covering entity-set changes); gating
  // on selectedId avoids re-collecting on every render. ----
  useEffect(() => {
    const doc = useStore.getState().document;
    snapCandidatesRef.current = collectSnapCandidates3D(doc, selectedId);
  }, [selectedId]);

  // ---- Sync target from entity on id change ----
  useEffect(() => {
    if (!entity) return;
    const t = targetRef.current;
    const rp = toRenderPosition(entity.position, renderOrigin);
    t.position.set(rp[0], rp[1], rp[2]);
    t.rotation.set(entity.rotation[0], entity.rotation[1], entity.rotation[2]);
    t.scale.set(1, 1, 1);
    t.updateMatrixWorld(true);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Sync target from entity after a committed dispatch ----
  useEffect(() => {
    if (!entity) return;
    const t = targetRef.current;
    const rp = toRenderPosition(entity.position, renderOrigin);
    t.position.set(rp[0], rp[1], rp[2]);
    t.rotation.set(entity.rotation[0], entity.rotation[1], entity.rotation[2]);
    t.scale.set(1, 1, 1);
    t.updateMatrixWorld(true);
  }, [entity, renderOrigin]);

  // ---- Per-frame snap computation (translate only) ----
  useFrame(() => {
    if (!isDraggingRef.current || mode !== 'translate' || !snap3dEnabled) {
      // Ensure indicator is cleared when not snapping.
      if (prevIndicatorTypeRef.current !== 'none') {
        prevIndicatorTypeRef.current = 'none';
        setIndicatorType('none');
      }
      return;
    }

    const t = targetRef.current;
    // t.position is in RENDER space (relative to floating-origin group).
    // Convert to world space for snap computation.
    const worldX = t.position.x + renderOrigin[0];
    const worldY = t.position.y + renderOrigin[1];
    const worldZ = t.position.z + renderOrigin[2];

    const result = snap3d(
      worldX, worldY, worldZ,
      snapCandidatesRef.current,
      SNAP3D_TOLERANCE,
      SNAP3D_GRID_STEP,
    );

    // Store for drag-end consumption.
    activeSnapRef.current = result.snapped ? { x: result.x, y: result.y, z: result.z, type: result.type } : null;

    // Update indicator — only call setState when the value actually changed to
    // avoid triggering unnecessary React re-renders on every frame.
    const renderSnapX = result.x - renderOrigin[0];
    const renderSnapY = result.y - renderOrigin[1];
    const renderSnapZ = result.z - renderOrigin[2];
    const newPos: readonly [number, number, number] = [renderSnapX, renderSnapY, renderSnapZ];
    const newType: Snap3DType = result.snapped ? result.type : 'none';

    const posChanged =
      newPos[0] !== prevIndicatorPosRef.current[0] ||
      newPos[1] !== prevIndicatorPosRef.current[1] ||
      newPos[2] !== prevIndicatorPosRef.current[2];
    const typeChanged = newType !== prevIndicatorTypeRef.current;

    if (posChanged) {
      prevIndicatorPosRef.current = newPos;
      setIndicatorPos(newPos);
    }
    if (typeChanged) {
      prevIndicatorTypeRef.current = newType;
      setIndicatorType(newType);
    }
  });

  // ---- dragging-changed handler ----
  const handleDraggingChanged = useCallback(
    (event: { value: boolean }) => {
      const dragging = event.value;
      onDraggingChanged(dragging);
      isDraggingRef.current = dragging;

      if (dragging) {
        // Snapshot pre-drag baseline and rebuild candidates.
        const t = targetRef.current;
        preDragPos.current.copy(t.position);
        preDragRot.current.copy(t.rotation);
        preDragScale.current.copy(t.scale);
        // Rebuild snap candidates at drag start (latest entity state).
        const doc = useStore.getState().document;
        snapCandidatesRef.current = collectSnapCandidates3D(doc, selectedId);
        activeSnapRef.current = null;
        return;
      }

      // Drag ended — clear indicator.
      prevIndicatorTypeRef.current = 'none';
      setIndicatorType('none');

      if (!selectedId) return;
      const t = targetRef.current;

      if (mode === 'translate') {
        // Apply snapped position to the gizmo target before computing delta.
        const snap = activeSnapRef.current;
        if (snap && snap3dEnabled) {
          const renderX = snap.x - renderOrigin[0];
          const renderY = snap.y - renderOrigin[1];
          const renderZ = snap.z - renderOrigin[2];
          t.position.set(renderX, renderY, renderZ);
        }

        const delta = computeTranslateDelta(preDragPos.current, t.position);
        const mag = Math.sqrt(delta[0] ** 2 + delta[1] ** 2 + delta[2] ** 2);
        if (mag < 1e-6) return;
        dispatch('move_entity', { id: selectedId, delta });

      } else if (mode === 'rotate') {
        const delta = computeRotateDelta(preDragRot.current, t.rotation);
        const mag = Math.sqrt(delta[0] ** 2 + delta[1] ** 2 + delta[2] ** 2);
        if (mag < 1e-6) return;
        dispatch('rotate_entity', { id: selectedId, delta });

      } else {
        // scale — derive uniform factor relative to the pre-drag scale baseline.
        const prevAvg = (preDragScale.current.x + preDragScale.current.y + preDragScale.current.z) / 3;
        const nextFactor = computeScaleFactor(t.scale);
        const factor = prevAvg > 0 ? nextFactor / prevAvg : nextFactor;
        if (Math.abs(factor - 1) < 1e-6 || factor <= 0) return;
        dispatch('scale_entity', { id: selectedId, factor });
        // Reset gizmo scale to neutral; geometry dimensions live in the entity.
        t.scale.set(1, 1, 1);
      }
    },
    [selectedId, mode, dispatch, onDraggingChanged, snap3dEnabled, renderOrigin],
  );

  // ---- Wire / re-wire event listener when handler or controls change ----
  useEffect(() => {
    const ctrl = controlsRef.current as (DraggingDispatcher & TransformControlsImpl) | null;
    if (!ctrl) return;
    ctrl.addEventListener('dragging-changed', handleDraggingChanged);
    return () => ctrl.removeEventListener('dragging-changed', handleDraggingChanged);
  }, [handleDraggingChanged]);

  if (!entity || !selectedId) return null;

  return (
    <>
      <TransformControls
        ref={controlsRef}
        object={targetRef.current}
        mode={mode}
        size={0.8}
      />
      {snap3dEnabled && mode === 'translate' && indicatorType !== 'none' && (
        <SnapIndicator3D position={indicatorPos} snapType={indicatorType} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// GizmoModeToggle — small overlay rendered outside the Canvas
// ---------------------------------------------------------------------------

interface ModeToggleProps {
  mode: GizmoMode;
  onMode: (m: GizmoMode) => void;
}

const MODES: ReadonlyArray<{ readonly id: GizmoMode; readonly label: string; readonly key: string }> = [
  { id: 'translate', label: 'Move', key: 'G' },
  { id: 'rotate', label: 'Rotate', key: 'R' },
  { id: 'scale', label: 'Scale', key: 'S' },
];

export function GizmoModeToggle({ mode, onMode }: ModeToggleProps): React.ReactElement {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: 4,
        background: 'rgba(18,22,32,0.82)',
        borderRadius: 8,
        padding: '4px 6px',
        backdropFilter: 'blur(4px)',
        boxShadow: '0 2px 12px rgba(0,0,0,0.45)',
        zIndex: 10,
        userSelect: 'none',
      }}
    >
      {MODES.map(({ id, label, key }) => (
        <button
          key={id}
          aria-pressed={mode === id}
          aria-label={`${label} (${key})`}
          onClick={() => onMode(id)}
          style={{
            padding: '4px 10px',
            borderRadius: 5,
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: 'inherit',
            fontWeight: mode === id ? 700 : 400,
            background: mode === id ? '#3a7bd5' : 'transparent',
            color: mode === id ? '#fff' : '#8fa0be',
            transition: 'background 0.12s, color 0.12s',
          }}
        >
          {label}
          <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.6 }}>{key}</span>
        </button>
      ))}
    </div>
  );
}
