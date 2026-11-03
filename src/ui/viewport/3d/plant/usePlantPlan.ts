// The render plan of the plant scene for the current camera, computed in the same render as the coverage (no effect state): the plan
// always belongs to exactly the scene it is used with. Null (so the per-entity path draws everything) without a camera view, without a
// scene, or while the camera is unplannable (zero-size canvas). It subscribes to camera bumps only while a scene is active.

import { useMemo, useRef } from 'react';
import { type PlanScene, type RenderPlan, planRender } from '@core/geometry/renderPlan';
import { useStore } from '@ui/store';
import { usePlantCameraView } from './PlantCameraProvider';
import { motionCamera, planCameraOf } from './plantPlanCamera';

export interface PlantPlan {
  readonly scene: PlanScene;
  readonly plan: RenderPlan;
  /** The camera is moving: widened frustum, size-culled instances kept as boxes. */
  readonly moving: boolean;
}

export function usePlantPlan(scene: PlanScene | null): PlantPlan | null {
  const view = usePlantCameraView(scene !== null);
  const previous = useRef<{ scene: PlanScene; levels: Uint8Array } | null>(null);
  return useMemo(() => {
    if (scene === null || view === null) return null;
    const base = planCameraOf(view.camera, useStore.getState().renderOrigin, view.width, view.height);
    if (base === null) return null;
    const previousLevels = previous.current?.scene === scene ? previous.current.levels : undefined;
    const plan = planRender(scene, view.moving ? motionCamera(base) : base, {
      multiDraw: true,
      quality: 'medium',
      ...(previousLevels && { previousLevels }),
    });
    previous.current = { scene, levels: plan.levels };
    return { scene, plan, moving: view.moving };
  }, [scene, view]);
}
