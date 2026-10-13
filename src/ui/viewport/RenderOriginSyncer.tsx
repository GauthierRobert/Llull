// Per-frame floating-origin rebase (2D + 3D): past the threshold, camera + target shift with the entity group and
// `renderOrigin` updates once. Needs `makeDefault` controls; camera drivers must invalidate() + controls.update().

import { useFrame, useThree } from '@react-three/fiber';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useStore } from '@ui/store';
import { shouldRebase, snapOriginToTarget } from './3d/floatingOrigin';

export function RenderOriginSyncer(): null {
  const { camera, controls } = useThree();

  useFrame(() => {
    const orbit = controls as OrbitControlsImpl | null;
    if (!orbit?.target) return;
    // Per frame: the store updates synchronously, so the next frame sees a rebase.
    const { renderOrigin: origin, setRenderOrigin } = useStore.getState();
    const worldTarget: [number, number, number] = [orbit.target.x + origin[0], orbit.target.y + origin[1], orbit.target.z + origin[2]];
    if (!shouldRebase(worldTarget, origin)) return;
    const newOrigin = snapOriginToTarget(worldTarget);
    const dx = newOrigin[0] - origin[0];
    const dy = newOrigin[1] - origin[1];
    const dz = newOrigin[2] - origin[2];
    camera.position.x -= dx;
    camera.position.y -= dy;
    camera.position.z -= dz;
    orbit.target.x -= dx;
    orbit.target.y -= dy;
    orbit.target.z -= dz;
    orbit.update();
    setRenderOrigin(newOrigin);
  });

  return null;
}
