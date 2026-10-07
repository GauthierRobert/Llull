/**
 * @layer ui/viewport/2d
 *
 * Invisible 1e8-square plane at height `z` that the 2D interaction layers use to capture pointer
 * events on the drafting plane. Geometry + material are disposed on unmount (R9).
 */

import * as THREE from 'three';
import type { MeshProps } from '@react-three/fiber';
import type { Vec2 } from '@core/model/types';
import { useStore } from '@ui/store';
import { useDisposable } from '../useDisposable';

type GroundPlaneProps = Pick<
  MeshProps,
  'onPointerMove' | 'onPointerDown' | 'onPointerLeave' | 'onClick' | 'onDoubleClick'
> & { z?: number };

export function GroundPlane({ z = 0, ...handlers }: GroundPlaneProps): React.ReactElement {
  const geometry = useDisposable(() => new THREE.PlaneGeometry(1e8, 1e8), []);
  const material = useDisposable(
    () => new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    [],
  );
  return <mesh geometry={geometry} material={material} position={[0, 0, z]} {...handlers} />;
}

/** three.js hit points are render-space (document − renderOrigin); input and snapping work in document space. */
export function toDocumentPoint(hit: { x: number; y: number }): Vec2 {
  const [originX, originY] = useStore.getState().renderOrigin;
  return [hit.x + originX, hit.y + originY];
}
