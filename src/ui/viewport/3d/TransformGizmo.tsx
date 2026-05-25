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
 * @affects dispatches move_entity | rotate_entity | scale_entity on drag end
 */

import { useEffect, useRef, useCallback } from 'react';
import { TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import type { TransformControls as TransformControlsImpl } from 'three-stdlib';
import { useStore } from '@ui/store';
import type { Entity } from '@core/model/types';

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

  // ---- Sync target from entity on id change ----
  // Re-sync whenever the entity id changes (new selection). This initialises
  // the gizmo position to the entity's current location.
  useEffect(() => {
    if (!entity) return;
    const t = targetRef.current;
    t.position.set(entity.position[0], entity.position[1], entity.position[2]);
    t.rotation.set(entity.rotation[0], entity.rotation[1], entity.rotation[2]);
    t.scale.set(1, 1, 1);
    t.updateMatrixWorld(true);
    // Only on selectedId change, not every entity update (see "Feedback-loop
    // prevention" in the file header — post-dispatch sync uses the entity dep below).
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Sync target from entity after a committed dispatch ----
  // When the store updates (dispatch completed), the entity ref changes value;
  // we reset the gizmo target to the new transform so the next drag starts clean.
  // This is safe because this effect runs AFTER the drag ends and the dispatch
  // has completed — there is no in-progress drag at this point.
  useEffect(() => {
    if (!entity) return;
    const t = targetRef.current;
    t.position.set(entity.position[0], entity.position[1], entity.position[2]);
    t.rotation.set(entity.rotation[0], entity.rotation[1], entity.rotation[2]);
    t.scale.set(1, 1, 1);
    t.updateMatrixWorld(true);
  }, [entity]);

  // ---- dragging-changed handler ----
  const handleDraggingChanged = useCallback(
    (event: { value: boolean }) => {
      const isDragging = event.value;
      onDraggingChanged(isDragging);

      if (isDragging) {
        // Snapshot pre-drag baseline.
        const t = targetRef.current;
        preDragPos.current.copy(t.position);
        preDragRot.current.copy(t.rotation);
        preDragScale.current.copy(t.scale);
        return;
      }

      // Drag ended — compute delta and dispatch.
      if (!selectedId) return;
      const t = targetRef.current;

      if (mode === 'translate') {
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
    [selectedId, mode, dispatch, onDraggingChanged],
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
    <TransformControls
      ref={controlsRef}
      object={targetRef.current}
      mode={mode}
      size={0.8}
    />
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
