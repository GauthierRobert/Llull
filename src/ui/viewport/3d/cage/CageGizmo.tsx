// Gizmo adapter: TransformControls on a proxy at the selection centroid translates / rotates / scales the picked cage elements.
// Floating origin: the proxy sits at the LOCAL origin of a group placed at the selection centroid, so every value the controls read and write
// (position delta, rotation, scale) is a small offset and large document coordinates cannot lose precision; the world pivot is the group position.
// Same pattern as TransformGizmo: the proxy is driven mid-drag (the preview follows through the gesture), and on release ONE
// command is dispatched (commitGesture -> edit_subdivision_cage) -- nothing is mutated here.

import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import type { TransformControls as TransformControlsImpl } from 'three-stdlib';
import type { SubdivisionEntity, Vec3 } from '@core/model/types';
import { useToolStore } from '@ui/store';
import { type CageSelection, selectionCentroidWorld } from './cageSelection';
import { quaternionAxisAngle } from './dragMath';
import { commitGesture, updateGesture } from './gestureActions';

type ControlsEvents = {
  addEventListener(type: 'dragging-changed', cb: (event: { value: boolean }) => void): void;
  removeEventListener(type: 'dragging-changed', cb: (event: { value: boolean }) => void): void;
  addEventListener(type: 'objectChange', cb: () => void): void;
  removeEventListener(type: 'objectChange', cb: () => void): void;
};

interface CageGizmoProps {
  readonly cage: SubdivisionEntity;
  readonly selection: CageSelection;
  readonly onDraggingChanged: (dragging: boolean) => void;
}

export function CageGizmo({ cage, selection, onDraggingChanged }: CageGizmoProps): React.ReactElement | null {
  const mode = useToolStore((s) => s.gizmoMode);
  const centroid = useMemo(() => selectionCentroidWorld(cage, selection), [cage, selection]);
  const targetRef = useRef<THREE.Group | null>(null);
  const controlsRef = useRef<TransformControlsImpl>(null);
  const dragging = useRef(false);
  const centroidRef = useRef<Vec3>([0, 0, 0]);
  centroidRef.current = centroid ?? centroidRef.current;
  const start = useRef({ position: new THREE.Vector3(), quaternion: new THREE.Quaternion() });

  const resetTarget = useCallback((): void => {
    const target = targetRef.current;
    if (target === null || centroid === null) return;
    target.position.set(0, 0, 0);
    target.quaternion.identity();
    target.scale.set(1, 1, 1);
    target.updateMatrixWorld(true);
  }, [centroid]);

  useEffect(() => {
    if (!dragging.current) resetTarget();
  }, [resetTarget]);

  const onChange = useCallback((): void => {
    const target = targetRef.current;
    if (target === null || !dragging.current) return;
    const pivot = centroidRef.current;
    if (mode === 'translate') {
      const delta = target.position.clone().sub(start.current.position);
      updateGesture({ kind: 'translate', delta: [delta.x, delta.y, delta.z] });
    } else if (mode === 'rotate') {
      const delta = target.quaternion.clone().multiply(start.current.quaternion.clone().invert());
      const { axis, angleDeg } = quaternionAxisAngle(delta);
      updateGesture({ kind: 'rotate', axis, angleDeg, pivot });
    } else {
      updateGesture({ kind: 'scale', factors: [target.scale.x, target.scale.y, target.scale.z], pivot });
    }
  }, [mode]);

  const onDragging = useCallback(
    (event: { value: boolean }): void => {
      dragging.current = event.value;
      onDraggingChanged(event.value);
      const target = targetRef.current;
      if (target === null) return;
      if (event.value) {
        start.current.position.copy(target.position);
        start.current.quaternion.copy(target.quaternion);
        return;
      }
      commitGesture();
      resetTarget();
    },
    [onDraggingChanged, resetTarget],
  );

  useEffect(() => {
    const controls = controlsRef.current as (ControlsEvents & TransformControlsImpl) | null;
    if (controls === null) return undefined;
    controls.addEventListener('dragging-changed', onDragging);
    controls.addEventListener('objectChange', onChange);
    return () => {
      controls.removeEventListener('dragging-changed', onDragging);
      controls.removeEventListener('objectChange', onChange);
    };
  }, [onDragging, onChange]);

  if (centroid === null) return null;
  return (
    <>
      <group position={[centroid[0], centroid[1], centroid[2]]}>
        <group ref={targetRef} />
      </group>
      <TransformControls ref={controlsRef} object={targetRef as unknown as MutableRefObject<THREE.Object3D>} mode={mode} size={0.8} />
    </>
  );
}
