// Playback math for simulate_motion poses: a body's sampled centre of mass + rotation (from its start pose), interpolated at a playback
// time, moves each member entity rigidly: p = q·(p0 − c0) + c(t), orientation = q · R0. Pure; pooled THREE temporaries, no allocation.

import * as THREE from 'three';
import type { Vec3 } from '@core/model/types';

/** The `poses` block of simulate_motion data. */
export interface DynamicsPoses {
  readonly times: readonly number[];
  readonly bodies: Readonly<Record<string, { readonly position: readonly Vec3[]; readonly orientation: readonly (readonly number[])[] }>>;
}

/** Index i and blend f with times[i] <= t <= times[i+1] (clamped to the ends). */
export function sampleAt(times: readonly number[], t: number): { index: number; blend: number } {
  const last = times.length - 1;
  if (last <= 0 || t <= (times[0] ?? 0)) return { index: 0, blend: 0 };
  if (t >= (times[last] ?? 0)) return { index: Math.max(0, last - 1), blend: last === 0 ? 0 : 1 };
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if ((times[mid] ?? 0) <= t) low = mid;
    else high = mid;
  }
  const t0 = times[low] ?? 0;
  const t1 = times[high] ?? t0;
  return { index: low, blend: t1 > t0 ? (t - t0) / (t1 - t0) : 0 };
}

export interface BodyFrame {
  /** Centre of mass now. */
  readonly center: THREE.Vector3;
  /** Rotation from the start pose. */
  readonly rotation: THREE.Quaternion;
  /** Centre of mass at t = 0. */
  readonly start: THREE.Vector3;
}

export function createBodyFrame(): BodyFrame {
  return { center: new THREE.Vector3(), rotation: new THREE.Quaternion(), start: new THREE.Vector3() };
}

const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

/**
 * The body's frame at playback time `t` into `frame`; false when the body has no samples. Rotation: slerp between samples, so the
 * playback is exact at samples (sample faster than a quarter turn per sample for a faithful spin — the panel picks the rate).
 */
export function bodyFrameAt(poses: DynamicsPoses, bodyId: string, t: number, frame: BodyFrame): boolean {
  const body = poses.bodies[bodyId];
  const first = body?.position[0];
  if (body === undefined || first === undefined) return false;
  const { index, blend } = sampleAt(poses.times, t);
  const p0 = body.position[index] ?? first;
  const p1 = body.position[index + 1] ?? p0;
  frame.start.set(first[0], first[1], first[2]);
  frame.center.set(p0[0] + (p1[0] - p0[0]) * blend, p0[1] + (p1[1] - p0[1]) * blend, p0[2] + (p1[2] - p0[2]) * blend);
  const o0 = body.orientation[index] ?? [1, 0, 0, 0];
  const o1 = body.orientation[index + 1] ?? o0;
  qa.set(o0[1] ?? 0, o0[2] ?? 0, o0[3] ?? 0, o0[0] ?? 1);
  qb.set(o1[1] ?? 0, o1[2] ?? 0, o1[3] ?? 0, o1[0] ?? 1);
  frame.rotation.slerpQuaternions(qa, qb, blend);
  return true;
}

const euler = new THREE.Euler();
const base = new THREE.Quaternion();

/** Pose of an entity (base position + XYZ euler) carried by `frame` into `position` / `quaternion`. */
export function carryEntity(
  frame: BodyFrame,
  basePosition: Vec3,
  baseRotation: Vec3,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
): void {
  position.set(basePosition[0], basePosition[1], basePosition[2]).sub(frame.start).applyQuaternion(frame.rotation).add(frame.center);
  euler.set(baseRotation[0], baseRotation[1], baseRotation[2], 'XYZ');
  quaternion.copy(base.setFromEuler(euler)).premultiply(frame.rotation);
}
