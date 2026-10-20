// In-Canvas arrow grip of a feature session: a shaft from the anchor to the grip and a cone head you drag along the handle axis.
// Pointer rays go to the pure `createHandleDrag`; OrbitControls is parked while a drag runs. Release reports a change once.

import { useMemo, useRef } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useStore } from '@ui/store';
import { toRenderPosition } from '../floatingOrigin';
import { type HandleFrame } from './featurePlan';
import { type HandleDrag, createHandleDrag } from './handleDrag';
import type { Vec3 } from './manipulatorMath';

interface FeatureHandleProps {
  frame: HandleFrame;
  value: number;
  step: number;
  minimum: number;
  color: string;
  onValue: (value: number) => void;
  /** Pointer released after the value changed. */
  onRelease: () => void;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

export function FeatureHandle({ frame, value, step, minimum, color, onValue, onRelease }: FeatureHandleProps): React.ReactElement {
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const renderOrigin = useStore((s) => s.renderOrigin);
  const dragRef = useRef<HandleDrag | null>(null);

  const { origin, axis, scale } = frame;
  const headLength = scale * 0.1;
  const headRadius = scale * 0.035;
  const shaftLength = Math.abs(value);
  const direction = useMemo(() => new THREE.Vector3(...axis).multiplyScalar(Math.sign(value) || 1), [axis, value]);
  const quaternion = useMemo(() => new THREE.Quaternion().setFromUnitVectors(Y_AXIS, direction), [direction]);
  const gripCentre: Vec3 = [
    origin[0] + axis[0] * value + direction.x * headLength * 0.5,
    origin[1] + axis[1] * value + direction.y * headLength * 0.5,
    origin[2] + axis[2] * value + direction.z * headLength * 0.5,
  ];
  const shaftCentre: Vec3 = [origin[0] + axis[0] * value * 0.5, origin[1] + axis[1] * value * 0.5, origin[2] + axis[2] * value * 0.5];

  const ray = (event: ThreeEvent<PointerEvent>): { origin: Vec3; direction: Vec3 } => ({
    origin: [event.ray.origin.x, event.ray.origin.y, event.ray.origin.z],
    direction: [event.ray.direction.x, event.ray.direction.y, event.ray.direction.z],
  });

  const onPointerDown = (event: ThreeEvent<PointerEvent>): void => {
    event.stopPropagation();
    const drag = createHandleDrag({ origin: toRenderPosition(origin, renderOrigin), axis, step, minimum });
    if (!drag.begin(ray(event), value)) return;
    dragRef.current = drag;
    (event.target as Element).setPointerCapture(event.pointerId);
    if (controls !== null) controls.enabled = false;
  };
  const onPointerMove = (event: ThreeEvent<PointerEvent>): void => {
    const next = dragRef.current?.move(ray(event));
    if (next !== null && next !== undefined) onValue(next);
  };
  const onPointerUp = (event: ThreeEvent<PointerEvent>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    dragRef.current = null;
    (event.target as Element).releasePointerCapture(event.pointerId);
    if (controls !== null) controls.enabled = true;
    if (drag.end()) onRelease();
  };

  return (
    <group name="feature-handle" renderOrder={10}>
      {shaftLength > 0 && (
        <mesh position={shaftCentre} quaternion={quaternion} raycast={() => undefined}>
          <cylinderGeometry args={[scale * 0.006, scale * 0.006, shaftLength, 8]} />
          <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.9} />
        </mesh>
      )}
      <mesh
        position={gripCentre}
        quaternion={quaternion}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <coneGeometry args={[headRadius, headLength, 20]} />
        <meshBasicMaterial color={color} depthTest={false} />
      </mesh>
    </group>
  );
}
