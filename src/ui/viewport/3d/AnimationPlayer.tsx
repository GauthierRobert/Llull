/**
 * @layer ui/viewport/3d
 *
 * AnimationPlayer — evaluates `document.animations` per-frame and drives
 * three.js transforms for animated entities and groups.
 *
 * Must be mounted INSIDE the Canvas so `useFrame` and `useThree` resolve.
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
 *   order: quaternions are multiplied (q_last * … * q_first) and position offsets
 *   are accumulated on top of the base position.
 * - If the target object is not found in the scene (scene.getObjectByName) the
 *   animation is silently skipped that frame.
 *
 * @pure   N/A — imperative three.js mutation; by design (render-time overlay).
 */

import { useRef, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore, useViewportStore } from '@ui/store';
import type { Entity, Vec3 } from '@core/model/types';
import { evaluateAnimationScalar } from './animationMath';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise a Vec3 direction. Returns a zero vector if the input is near-zero. */
function normalise(v: Vec3): THREE.Vector3 {
  const vec = new THREE.Vector3(v[0], v[1], v[2]);
  const len = vec.length();
  if (len < 1e-9) return new THREE.Vector3(0, 1, 0); // safe fallback: Y axis
  return vec.divideScalar(len);
}

/** Compute the centroid of a list of document positions. */
function centroid(positions: Vec3[]): Vec3 {
  if (positions.length === 0) return [0, 0, 0];
  let x = 0, y = 0, z = 0;
  for (const p of positions) {
    x += p[0]; y += p[1]; z += p[2];
  }
  const n = positions.length;
  return [x / n, y / n, z / n];
}

// ---------------------------------------------------------------------------
// AnimationPlayer
// ---------------------------------------------------------------------------

/** Mounted inside the Canvas; renders null. Drives transforms per-frame via useFrame. */
export function AnimationPlayer(): null {
  const { scene } = useThree();

  // Phase accumulators: animId → seconds of running time.
  const phaseMap = useRef<Map<string, number>>(new Map());

  // Track the last known reset nonce so we can detect a bump.
  const lastResetNonce = useRef<number>(useViewportStore.getState().animationResetNonce);

  // Reusable THREE objects — allocated once, reused each frame to avoid GC.
  const _q = useRef(new THREE.Quaternion());
  const _baseQ = useRef(new THREE.Quaternion());
  const _v = useRef(new THREE.Vector3());
  const _offset = useRef(new THREE.Vector3());

  // invalidate() keeps the demand Canvas refreshing while animations are running.
  const invalidate = useThree((s) => s.invalidate);

  // Keep a ref to invalidate so useFrame closure captures the ref, not a stale fn.
  const invalidateRef = useRef(invalidate);
  useEffect(() => { invalidateRef.current = invalidate; }, [invalidate]);

  useFrame((_state, delta) => {
    const vpState = useViewportStore.getState();
    const doc = useStore.getState().document;

    // ---- Detect reset ---------------------------------------------------
    const currentNonce = vpState.animationResetNonce;
    if (currentNonce !== lastResetNonce.current) {
      phaseMap.current.clear();
      lastResetNonce.current = currentNonce;
    }

    const { animations, entities, groups } = doc;
    const { animationPlaying, activeClickAnimationIds } = vpState;

    // Build a list of (animation, memberIds) pairs sorted by the order they
    // appear in the animations Record (insertion order — consistent each frame).
    const animList = Object.values(animations);
    if (animList.length === 0) return;

    // We are doing work this frame — keep demand Canvas alive.
    if (animationPlaying || activeClickAnimationIds.size > 0) {
      invalidateRef.current();
    }

    // ---- Collect per-entity composed transforms -------------------------
    // entityId → { position: THREE.Vector3, quaternion: THREE.Quaternion }
    // We accumulate all animations targeting each entity before applying,
    // composing position offsets and multiplying quaternions.

    interface ComposedTransform {
      position: THREE.Vector3;
      quaternion: THREE.Quaternion;
      hasRotation: boolean;
      hasPosition: boolean;
    }
    const composed = new Map<string, ComposedTransform>();

    for (const anim of animList) {
      const running =
        anim.trigger === 'auto'
          ? animationPlaying
          : activeClickAnimationIds.has(anim.id);

      // Advance phase (frozen when not running).
      const prevPhase = phaseMap.current.get(anim.id) ?? 0;
      const phase = running ? prevPhase + delta : prevPhase;
      phaseMap.current.set(anim.id, phase);

      // Resolve member entity ids.
      let memberIds: string[];
      if (anim.targetKind === 'entity') {
        memberIds = [anim.targetId];
      } else {
        memberIds = groups[anim.targetId]?.memberIds ?? [];
      }
      if (memberIds.length === 0) continue;

      // Axis (normalised).
      const axis = normalise(anim.axis);

      // Compute pivot for rotation animations.
      let pivotVec: THREE.Vector3 | null = null;
      if (anim.channel === 'rotation') {
        if (anim.pivot) {
          pivotVec = new THREE.Vector3(anim.pivot[0], anim.pivot[1], anim.pivot[2]);
        } else if (anim.targetKind === 'entity') {
          const e = entities[anim.targetId];
          if (e) pivotVec = new THREE.Vector3(e.position[0], e.position[1], e.position[2]);
        } else {
          // Group: centroid of member positions.
          const positions: Vec3[] = memberIds
            .map((id) => entities[id]?.position)
            .filter((p): p is Vec3 => p !== undefined);
          const c = centroid(positions);
          pivotVec = new THREE.Vector3(c[0], c[1], c[2]);
        }
        if (!pivotVec) pivotVec = new THREE.Vector3(0, 0, 0);
      }

      // Compute the animation scalar for this frame via the pure helper.
      const scalar = evaluateAnimationScalar(anim, phase);
      const angle = anim.channel === 'rotation' ? scalar : 0;
      const distance = anim.channel === 'position' ? scalar : 0;

      // Build the quaternion for this animation (rotation channel only).
      _q.current.setFromAxisAngle(axis, angle);

      // Apply to each member entity.
      for (const memberId of memberIds) {
        const entity: Entity | undefined = entities[memberId];
        if (!entity) continue;

        // Initialise composed entry from the document base if not yet present.
        let entry: ComposedTransform;
        if (!composed.has(memberId)) {
          const basePos = entity.position;
          const baseRot = entity.rotation;
          _baseQ.current.setFromEuler(
            new THREE.Euler(baseRot[0], baseRot[1], baseRot[2], 'XYZ'),
          );
          entry = {
            position: new THREE.Vector3(basePos[0], basePos[1], basePos[2]),
            quaternion: _baseQ.current.clone(),
            hasRotation: false,
            hasPosition: false,
          };
          composed.set(memberId, entry);
        } else {
          // Safe: we just checked has() so the value is present.
          entry = composed.get(memberId) as ComposedTransform;
        }

        if (anim.channel === 'rotation' && pivotVec) {
          // newQuat = q * prevQuat (compose on top)
          entry.quaternion.premultiply(_q.current);
          entry.hasRotation = true;

          // Rotate position around pivot.
          // delta_from_pivot = currentPos - pivot
          _v.current.copy(entry.position).sub(pivotVec);
          _v.current.applyQuaternion(_q.current);
          entry.position.copy(pivotVec).add(_v.current);
          entry.hasPosition = true;
        } else if (anim.channel === 'position') {
          // Offset along (possibly accumulated) axis direction.
          _offset.current.copy(axis).multiplyScalar(distance);
          entry.position.add(_offset.current);
          entry.hasPosition = true;
        }
      }
    }

    // ---- Apply composed transforms to scene objects ----------------------
    for (const [entityId, transform] of composed) {
      const obj = scene.getObjectByName(entityId);
      if (!obj) continue;
      if (transform.hasPosition || transform.hasRotation) {
        obj.position.copy(transform.position);
        obj.quaternion.copy(transform.quaternion);
      }
    }
  });

  return null;
}
