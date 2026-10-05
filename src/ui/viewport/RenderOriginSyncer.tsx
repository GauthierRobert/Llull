/**
 * @layer ui/viewport
 *
 * Per-frame floating-origin rebase shared by the 2D and 3D viewports. When the controls target
 * (render-space) drifts beyond the rebase threshold, the camera + target shift with the entity
 * group and `renderOrigin` is updated once. Mount inside a Canvas with `makeDefault` controls.
 * COUPLING: camera-driving code must `invalidate()` + `controls.update()` so this frame runs.
 */

import { useFrame, useThree } from '@react-three/fiber';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useStore } from '@ui/store';
import { shouldRebase, snapOriginToTarget } from './3d/floatingOrigin';

export function RenderOriginSyncer(): null {
  const { camera, controls } = useThree();

  useFrame(() => {
    const orbit = controls as OrbitControlsImpl | null;
    if (!orbit?.target) return;
    // Read per frame: the store updates synchronously, so a rebase is visible to the next frame.
    const { renderOrigin: origin, setRenderOrigin } = useStore.getState();
    const worldTarget: [number, number, number] = [
      orbit.target.x + origin[0],
      orbit.target.y + origin[1],
      orbit.target.z + origin[2],
    ];
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
