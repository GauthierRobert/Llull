/**
 * Evaluates `document.animations` per frame into three.js transforms (in-Canvas, renders null, ref-only work, R9).
 * 'auto' animations run while `animationPlaying`; 'click' ones while in `activeClickAnimationIds` (whatever the play
 * state). A reset nonce bump clears the phases (base pose). Base transforms are re-read from the document each frame;
 * several animations on one object compose in document order. Pooled buffers: no per-frame allocation. Objects
 * missing from the scene are skipped that frame.
 */

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useStore, useViewportStore } from '@ui/store';
import type { Animation } from '@core/model/types';
import {
  animationMembers,
  composeAnimatedPoseInto,
  createAnimatedPose,
  createContribution,
  fillAnimationContribution,
  type AnimatedPose,
  type AnimationContribution,
} from '@core/geometry/animationPose';
import { applyAnimatedPose } from './animationMath';
import { markSceneMoved } from './frameActivity';
import { SceneObjectCache } from './sceneObjectCache';

function createFrameBuffers(): {
  pose: AnimatedPose;
  contributionsByEntity: Map<string, AnimationContribution[]>;
  pool: AnimationContribution[];
} {
  return { pose: createAnimatedPose(), contributionsByEntity: new Map(), pool: [] };
}

export function AnimationPlayer(): null {
  // animId → seconds of running time.
  const phaseMap = useRef<Map<string, number>>(new Map());

  const lastResetNonce = useRef<number>(useViewportStore.getState().animationResetNonce);

  const buffers = useMemo(createFrameBuffers, []);
  const objectCache = useMemo(() => new SceneObjectCache(), []);
  // Animation list cached per `animations` identity (no Object.values per frame); last poses written, to flag idle frames.
  const cached = useRef<{ animations: unknown; list: Animation[]; entities: unknown }>({ animations: null, list: [], entities: null });

  useFrame(({ scene, invalidate }, delta) => {
    const viewport = useViewportStore.getState();
    const { animations, entities, groups } = useStore.getState().document;

    if (viewport.animationResetNonce !== lastResetNonce.current) {
      phaseMap.current.clear();
      lastResetNonce.current = viewport.animationResetNonce;
      // back to the base pose: this frame's write moves the scene
      cached.current.entities = null;
    }

    const { animationPlaying, activeClickAnimationIds } = viewport;

    if (cached.current.animations !== animations) cached.current = { animations, list: Object.values(animations), entities: null };
    const animList = cached.current.list;
    if (animList.length === 0) return;

    // Keep the demand Canvas alive.
    if (animationPlaying || activeClickAnimationIds.size > 0) invalidate();

    const { pose, contributionsByEntity, pool } = buffers;
    for (const [entityId, parts] of contributionsByEntity) {
      if (parts.length === 0) contributionsByEntity.delete(entityId);
      else parts.length = 0;
    }
    let pooled = 0;

    for (const anim of animList) {
      const running = anim.trigger === 'auto' ? animationPlaying : activeClickAnimationIds.has(anim.id);

      // Frozen when not running.
      const phase = (phaseMap.current.get(anim.id) ?? 0) + (running ? delta : 0);
      phaseMap.current.set(anim.id, phase);

      const memberIds = animationMembers(anim, groups);
      if (memberIds.length === 0) continue;

      const contribution = (pool[pooled] ??= createContribution());
      pooled += 1;
      fillAnimationContribution(contribution, anim, phase, memberIds, entities);
      for (const memberId of memberIds) {
        if (!entities[memberId]) continue;
        const parts = contributionsByEntity.get(memberId);
        if (parts) parts.push(contribution);
        else contributionsByEntity.set(memberId, [contribution]);
      }
    }

    // shadows are stale only when time runs or the document poses changed since the last write
    const moving = animationPlaying || activeClickAnimationIds.size > 0 || cached.current.entities !== entities;
    cached.current.entities = entities;
    for (const [entityId, parts] of contributionsByEntity) {
      const entity = entities[entityId];
      const object = objectCache.get(scene, entityId);
      if (!entity || !object || parts.length === 0) continue;
      composeAnimatedPoseInto(pose, entity.position, entity.rotation, parts);
      applyAnimatedPose(object, pose);
      if (moving) markSceneMoved();
    }
  });

  return null;
}
