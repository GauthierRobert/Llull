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
 *   order by `composeAnimatedPose` (animationMath).
 * - If the target object is not found in the scene (scene.getObjectByName) the
 *   animation is silently skipped that frame.
 *
 * @pure   N/A — imperative three.js mutation; by design (render-time overlay).
 */

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore, useViewportStore } from '@ui/store';
import type { Animation, CadDocument, Vec3 } from '@core/model/types';
import { ORIGIN, add3 } from '@lib/vec3';
import {
  composeAnimatedPose,
  evaluateAnimationScalar,
  type AnimationContribution,
} from './animationMath';

/** Normalise a Vec3 direction. Falls back to the Z axis (Z-up) for a near-zero vector. */
function normalise(v: Vec3): THREE.Vector3 {
  const vec = new THREE.Vector3(v[0], v[1], v[2]);
  const len = vec.length();
  if (len < 1e-9) return new THREE.Vector3(0, 0, 1);
  return vec.divideScalar(len);
}

/** Centroid of a list of document positions (the origin for an empty list). */
function centroid(positions: Vec3[]): Vec3 {
  const count = Math.max(positions.length, 1);
  const [x, y, z] = positions.reduce((total, p) => add3(total, p), ORIGIN);
  return [x / count, y / count, z / count];
}

/** Rotation pivot: the animation's own, else the target's position (a group's: member centroid). */
function pivotOf(
  anim: Animation,
  memberIds: string[],
  entities: CadDocument['entities'],
): THREE.Vector3 {
  const pivot =
    anim.pivot ??
    (anim.targetKind === 'entity'
      ? entities[anim.targetId]?.position
      : centroid(
          memberIds.map((id) => entities[id]?.position).filter((p): p is Vec3 => p !== undefined),
        ));
  return new THREE.Vector3(...(pivot ?? ORIGIN));
}

/** Pivot placeholder for position-channel contributions (unused by them). */
const NO_PIVOT = new THREE.Vector3();

/** Mounted inside the Canvas; renders null. Drives transforms per-frame via useFrame. */
export function AnimationPlayer(): null {
  // Phase accumulators: animId → seconds of running time.
  const phaseMap = useRef<Map<string, number>>(new Map());

  // Track the last known reset nonce so we can detect a bump.
  const lastResetNonce = useRef<number>(useViewportStore.getState().animationResetNonce);

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
    const contributions = new Map<string, AnimationContribution[]>();

    for (const anim of animList) {
      const running =
        anim.trigger === 'auto' ? animationPlaying : activeClickAnimationIds.has(anim.id);

      // Advance phase (frozen when not running).
      const phase = (phaseMap.current.get(anim.id) ?? 0) + (running ? delta : 0);
      phaseMap.current.set(anim.id, phase);

      const memberIds =
        anim.targetKind === 'entity' ? [anim.targetId] : (groups[anim.targetId]?.memberIds ?? []);
      if (memberIds.length === 0) continue;

      const contribution: AnimationContribution = {
        channel: anim.channel,
        axis: normalise(anim.axis),
        scalar: evaluateAnimationScalar(anim, phase),
        pivot: anim.channel === 'rotation' ? pivotOf(anim, memberIds, entities) : NO_PIVOT,
      };
      for (const memberId of memberIds) {
        if (entities[memberId]) {
          contributions.set(memberId, [...(contributions.get(memberId) ?? []), contribution]);
        }
      }
    }

    for (const [entityId, parts] of contributions) {
      const entity = entities[entityId];
      const object = scene.getObjectByName(entityId);
      if (!entity || !object) continue;
      const pose = composeAnimatedPose(entity.position, entity.rotation, parts);
      object.position.set(...pose.position);
      object.quaternion.set(...pose.quaternion);
    }
  });

  return null;
}
