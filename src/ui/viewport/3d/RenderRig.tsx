// In-Canvas render scheduler (demand frameloop). Mount it LAST in the scene so its useFrame runs after every pose writer
// (equal-priority callbacks run in mount order, and a priority > 0 would take over rendering from r3f).
//  - Shadow map: autoUpdate off; re-rendered only when casters changed: store edits, markSceneMoved(), or any caster's
//    world matrix / geometry differing from the last frame (whoever moved it: live transitions, previews, drags).
//  - Contact shadows: re-baked at <= CONTACT_BAKE_MAX_HZ while parts move, plus once on edits and once on settle.
//  - Resolution: reduced pixel ratio while the camera or the scene moves, full ratio again once calm.

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useStore, useViewportStore } from '@ui/store';
import { endFrame, sceneMovedThisFrame } from './frameActivity';
import { consumeShadowsDirty, markShadowsDirty, requestContactBake } from './renderRigState';
import { ShadowCasterSnapshot } from './shadowCasterSnapshot';
import {
  DPR_SETTLE_MS,
  INITIAL_ADAPTIVE_DPR,
  INITIAL_CONTACT_BAKE,
  cameraPoseChanged,
  contactBakeOwed,
  interactiveDpr,
  settledDpr,
  shouldRefreshShadows,
  stepAdaptiveDpr,
  stepContactBake,
} from './renderActivity';

/** The Canvas `dpr` range (settled ratio = device ratio clamped to it). */
export const CANVAS_DPR_RANGE: [number, number] = [1, 2];

/** Anything that can change what the shadow casters look like marks the shadow map dirty. */
function useShadowDirtySources(): void {
  useEffect(() => {
    const unsubscribeDocument = useStore.subscribe((state, previous) => {
      if (state.document !== previous.document || state.renderOrigin !== previous.renderOrigin) markShadowsDirty();
    });
    const unsubscribeViewport = useViewportStore.subscribe(markShadowsDirty);
    markShadowsDirty();
    return () => {
      unsubscribeDocument();
      unsubscribeViewport();
    };
  }, []);
}

export function RenderRig(): null {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const setDpr = useThree((s) => s.setDpr);
  const bake = useRef(INITIAL_CONTACT_BAKE);
  const dpr = useRef(INITIAL_ADAPTIVE_DPR);
  const pose = useRef(new Float64Array(7).fill(Number.NaN));
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const casters = useRef(new ShadowCasterSnapshot());

  useShadowDirtySources();

  useEffect(() => {
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    return () => {
      gl.shadowMap.autoUpdate = true;
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    };
  }, [gl]);

  useFrame(({ camera, scene }) => {
    const now = performance.now();
    scene.updateMatrixWorld();
    const animating = sceneMovedThisFrame();
    const moved = casters.current.update(scene) || animating;
    const dirty = consumeShadowsDirty();

    if (shouldRefreshShadows({ dirty, sceneMoved: moved })) gl.shadowMap.needsUpdate = true;

    const contact = stepContactBake(bake.current, moved || dirty, now);
    bake.current = contact.state;
    if (contact.bake) requestContactBake();
    if (contactBakeOwed(bake.current)) invalidate();

    const seeded = !Number.isNaN(pose.current[0]);
    const poseChanged = cameraPoseChanged(pose.current, [
      camera.position.x,
      camera.position.y,
      camera.position.z,
      camera.quaternion.x,
      camera.quaternion.y,
      camera.quaternion.z,
      camera.quaternion.w,
    ]);
    const settled = settledDpr(window.devicePixelRatio, CANVAS_DPR_RANGE);
    const reduced = interactiveDpr(settled);
    // Only continuous motion (orbit, playback) trades resolution: a one-off edit keeps the full ratio (no resize pop).
    const step = stepAdaptiveDpr(dpr.current, (poseChanged && seeded) || animating, now, reduced < settled);
    dpr.current = step.state;
    if (step.changed) setDpr(step.state.reduced ? reduced : settled);
    // No more frames are coming once calm: wake the loop to restore the full ratio (re-armed by that frame while still moving).
    if (step.state.reduced && settleTimer.current === null) {
      settleTimer.current = setTimeout(() => {
        settleTimer.current = null;
        invalidate();
      }, DPR_SETTLE_MS + 20);
    }

    endFrame();
  });

  return null;
}
