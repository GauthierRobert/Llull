/**
 * @layer ui/viewport/3d
 *
 * AnimationPlayer — evaluates `document.animations` per-frame and drives
 * three.js transforms for animated entities and groups.
 *
 * Must be mounted INSIDE the Canvas so `useFrame` resolves.
 * Renders nothing (returns null); all work is done via refs (rule R9).
 *
 * Behaviour:
 * - `trigger:'auto'`  animations run when `animationPlaying` is true.
 * - `trigger:'click'` animations run when their id is in `activeClickAnimationIds`
 *   (independent of the global play state — a click always works).
 * - `resetAnimations()` bumps `animationResetNonce`, causing the phase map to be
 *   cleared on the next frame so all animated objects return to base pose.
 * - Base transforms are read from `document.entities` every frame so the player
 *   is stable even if another system (e.g. TransformGizmo) has mutated the document.
 * - When multiple animations target the same object they are composed in document
 *   order by `composeAnimatedPoseInto` (animationMath).
 * - Per-frame work reuses pooled vectors / contributions (rule R9: no per-frame allocation).
 * - If the target object is not found in the scene (SceneObjectCache, a memoized getObjectByName) the
 *   animation is silently skipped that frame.
 *
 * @pure   N/A — imperative three.js mutation; by design (render-time overlay).
 */

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore, useViewportStore } from '@ui/store';
import type { Animation, CadDocument, Vec3 } from '@core/model/types';
import { ORIGIN } from '@lib/vec3';
import {
  composeAnimatedPoseInto,
  createPoseScratch,
  evaluateAnimationScalar,
  type AnimatedPose,
  type AnimationContribution,
} from './animationMath';
import { SceneObjectCache } from './sceneObjectCache';

/** Write the unit direction of `v` into `target`; falls back to the Z axis (Z-up) for a near-zero vector. */
function writeUnitAxis(target: THREE.Vector3, v: Vec3): void {
  target.set(v[0], v[1], v[2]);
  const len = target.length();
  if (len < 1e-9) target.set(0, 0, 1);
  else target.divideScalar(len);
}

/** Write the rotation pivot into `target`: the animation's own, else the target's position (a group's: member centroid). */
function writePivot(
  target: THREE.Vector3,
  anim: Animation,
  memberIds: string[],
  entities: CadDocument['entities'],
): void {
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

/** Per-frame scratch state of the player: pooled contributions, pose and math temporaries. */
function createFrameBuffers(): {
  pose: AnimatedPose;
  scratch: ReturnType<typeof createPoseScratch>;
  contributionsByEntity: Map<string, AnimationContribution[]>;
  pool: AnimationContribution[];
} {
  return {
    pose: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
    scratch: createPoseScratch(),
    contributionsByEntity: new Map(),
    pool: [],
  };
}

/** Mounted inside the Canvas; renders null. Drives transforms per-frame via useFrame. */
export function AnimationPlayer(): null {
  // Phase accumulators: animId → seconds of running time.
  const phaseMap = useRef<Map<string, number>>(new Map());

  // Track the last known reset nonce so we can detect a bump.
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

    // Animations run in the order of the animations Record (insertion order — consistent each frame).
    const animList = Object.values(animations);
    if (animList.length === 0) return;

    // We are doing work this frame — keep the demand Canvas alive.
    if (animationPlaying || activeClickAnimationIds.size > 0) invalidate();

    // Every animation targeting an entity contributes to its pose; contributions compose in order.
    const { pose, scratch, contributionsByEntity, pool } = buffers;
    for (const [entityId, parts] of contributionsByEntity) {
      if (parts.length === 0) contributionsByEntity.delete(entityId);
      else parts.length = 0;
    }
    let pooled = 0;

    for (const anim of animList) {
      const running =
        anim.trigger === 'auto' ? animationPlaying : activeClickAnimationIds.has(anim.id);

      // Advance phase (frozen when not running).
      const phase = (phaseMap.current.get(anim.id) ?? 0) + (running ? delta : 0);
      phaseMap.current.set(anim.id, phase);

      const memberIds =
        anim.targetKind === 'entity' ? [anim.targetId] : (groups[anim.targetId]?.memberIds ?? []);
      if (memberIds.length === 0) continue;

      const contribution = (pool[pooled] ??= {
        channel: anim.channel,
        axis: new THREE.Vector3(),
        scalar: 0,
        pivot: new THREE.Vector3(),
      });
      pooled += 1;
      contribution.channel = anim.channel;
      contribution.scalar = evaluateAnimationScalar(anim, phase);
      writeUnitAxis(contribution.axis, anim.axis);
      if (anim.channel === 'rotation') writePivot(contribution.pivot, anim, memberIds, entities);
      for (const memberId of memberIds) {
        if (!entities[memberId]) continue;
        const parts = contributionsByEntity.get(memberId);
        if (parts) parts.push(contribution);
        else contributionsByEntity.set(memberId, [contribution]);
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
