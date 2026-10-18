/**
 * Evaluates `document.animations` per frame into three.js transforms (in-Canvas, renders null, ref-only work, R9).
 * 'auto' animations run while `animationPlaying`; 'click' ones while in `activeClickAnimationIds` (whatever the play
 * state). A reset nonce bump clears the phases (base pose). Base transforms are re-read from the document each frame;
 * several animations on one object compose in document order. Pooled buffers: no per-frame allocation. Objects
 * missing from the scene are skipped that frame.
 */

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore, useViewportStore } from '@ui/store';
import type { Animation, CadDocument, Vec3 } from '@core/model/types';
import { ORIGIN } from '@lib/vec3';
import {
  composeAnimatedPoseInto,
  createLoopScratch,
  createPoseScratch,
  evaluateAnimationScalar,
  measureLoop,
  nearestLoopDistance,
  writeFollowPathContributions,
  type AnimatedPose,
  type AnimationContribution,
  type MeasuredLoop,
} from './animationMath';
import { SceneObjectCache } from './sceneObjectCache';

/** Unit direction of `v`, or +Z for a near-zero vector. */
function writeUnitAxis(target: THREE.Vector3, v: Vec3): void {
  target.set(v[0], v[1], v[2]);
  const len = target.length();
  if (len < 1e-9) target.set(0, 0, 1);
  else target.divideScalar(len);
}

/** The animation's pivot, else the target's position (a group's: its member centroid). */
function writePivot(target: THREE.Vector3, anim: Animation, memberIds: string[], entities: CadDocument['entities']): void {
  if (anim.pivot) {
    target.set(anim.pivot[0], anim.pivot[1], anim.pivot[2]);
  } else if (anim.targetKind === 'entity') {
    const [x, y, z] = entities[anim.targetId]?.position ?? ORIGIN;
    target.set(x, y, z);
  } else {
    target.set(0, 0, 0);
    let count = 0;
    for (const id of memberIds) {
      const position = entities[id]?.position;
      if (position === undefined) continue;
      target.x += position[0];
      target.y += position[1];
      target.z += position[2];
      count += 1;
    }
    const divisor = Math.max(count, 1);
    target.set(target.x / divisor, target.y / divisor, target.z / divisor);
  }
}

function createFrameBuffers(): {
  pose: AnimatedPose;
  scratch: ReturnType<typeof createPoseScratch>;
  loopScratch: ReturnType<typeof createLoopScratch>;
  contributionsByEntity: Map<string, AnimationContribution[]>;
  pool: AnimationContribution[];
  loops: WeakMap<ReadonlyArray<Vec3>, MeasuredLoop>;
  starts: WeakMap<Vec3, { loop: MeasuredLoop; start: number }>;
} {
  return {
    pose: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
    scratch: createPoseScratch(),
    loopScratch: createLoopScratch(),
    contributionsByEntity: new Map(),
    pool: [],
    loops: new WeakMap(),
    starts: new WeakMap(),
  };
}

function addContribution(contributionsByEntity: Map<string, AnimationContribution[]>, memberId: string, part: AnimationContribution): void {
  const parts = contributionsByEntity.get(memberId);
  if (parts) parts.push(part);
  else contributionsByEntity.set(memberId, [part]);
}

export function AnimationPlayer(): null {
  // animId → seconds of running time.
  const phaseMap = useRef<Map<string, number>>(new Map());

  const lastResetNonce = useRef<number>(useViewportStore.getState().animationResetNonce);

  const buffers = useMemo(createFrameBuffers, []);
  const objectCache = useMemo(() => new SceneObjectCache(), []);

  useFrame(({ scene, invalidate }, delta) => {
    const viewport = useViewportStore.getState();
    const { animations, entities, groups } = useStore.getState().document;

    if (viewport.animationResetNonce !== lastResetNonce.current) {
      phaseMap.current.clear();
      lastResetNonce.current = viewport.animationResetNonce;
    }

    const { animationPlaying, activeClickAnimationIds } = viewport;

    const animList = Object.values(animations);
    if (animList.length === 0) return;

    // Keep the demand Canvas alive.
    if (animationPlaying || activeClickAnimationIds.size > 0) invalidate();

    const { pose, scratch, loopScratch, contributionsByEntity, pool, loops, starts } = buffers;
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

      const memberIds = anim.targetKind === 'entity' ? [anim.targetId] : (groups[anim.targetId]?.memberIds ?? []);
      if (memberIds.length === 0) continue;

      if (anim.mode === 'follow_path') {
        if (anim.path === undefined) continue;
        const loop = loops.get(anim.path) ?? measureLoop(anim.path);
        loops.set(anim.path, loop);
        for (const memberId of memberIds) {
          const member = entities[memberId];
          if (!member) continue;
          const turn = (pool[pooled] ??= { channel: 'rotation', axis: new THREE.Vector3(), scalar: 0, pivot: new THREE.Vector3() });
          const shift = (pool[pooled + 1] ??= { channel: 'position', axis: new THREE.Vector3(), scalar: 0, pivot: new THREE.Vector3() });
          pooled += 2;
          // Commands are pure: a moved member gets a new position array, so the cached start follows it.
          let cached = starts.get(member.position);
          if (cached?.loop !== loop) {
            cached = { loop, start: nearestLoopDistance(loop, member.position) };
            starts.set(member.position, cached);
          }
          writeFollowPathContributions(loop, cached.start, anim.speed * phase, turn, shift, loopScratch);
          addContribution(contributionsByEntity, memberId, turn);
          addContribution(contributionsByEntity, memberId, shift);
        }
        continue;
      }

      const contribution = (pool[pooled] ??= { channel: anim.channel, axis: new THREE.Vector3(), scalar: 0, pivot: new THREE.Vector3() });
      pooled += 1;
      contribution.channel = anim.channel;
      contribution.scalar = evaluateAnimationScalar(anim, phase);
      writeUnitAxis(contribution.axis, anim.axis);
      if (anim.channel === 'rotation') writePivot(contribution.pivot, anim, memberIds, entities);
      for (const memberId of memberIds) {
        if (entities[memberId]) addContribution(contributionsByEntity, memberId, contribution);
      }
    }

    for (const [entityId, parts] of contributionsByEntity) {
      const entity = entities[entityId];
      const object = objectCache.get(scene, entityId);
      if (!entity || !object || parts.length === 0) continue;
      composeAnimatedPoseInto(pose, entity.position, entity.rotation, parts, scratch);
      object.position.copy(pose.position);
      object.quaternion.copy(pose.quaternion);
    }
  });

  return null;
}
