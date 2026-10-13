// Pure timing curves + transforms of the live-edit effects (no three.js scene access, unit-tested).

import * as THREE from 'three';
import type { Entity, Vec3 } from '@core/model/types';
import type { EntityTransition } from './planLiveFx';

/** 0 before `startMs`, 1 after `startMs + durationMs`. */
export function progressAt(nowMs: number, startMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1;
  return Math.min(1, Math.max(0, (nowMs - startMs) / durationMs));
}

/** Under-damped spring 0 → 1 (≈13 % overshoot near t = 0.29), settled at t = 1. */
export function springGrow(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - Math.exp(-7 * t) * Math.cos(11 * t);
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** Glow bell: ramps in over the first 12 %, decays to exactly 0 at t = 1. */
export function glowAt(t: number): number {
  if (t <= 0 || t >= 1) return 0;
  return t < 0.12 ? t / 0.12 : ((1 - t) / 0.88) ** 1.6;
}

/** Smallest scale written to a matrix (a zero scale would make raycasting invert a singular matrix). */
const MIN_SCALE = 1e-3;

const scratch = { a: new THREE.Matrix4(), b: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), v: new THREE.Vector3() };

function scaleAbout(out: THREE.Matrix4, pivot: Vec3, sx: number, sy: number, sz: number): THREE.Matrix4 {
  const [px, py, pz] = pivot;
  out.makeTranslation(px, py, pz);
  out.multiply(scratch.a.makeScale(Math.max(sx, MIN_SCALE), Math.max(sy, MIN_SCALE), Math.max(sz, MIN_SCALE)));
  return out.multiply(scratch.a.makeTranslation(-px, -py, -pz));
}

function poseMatrix(out: THREE.Matrix4, position: Vec3, quaternion: THREE.Quaternion): THREE.Matrix4 {
  return out.compose(scratch.v.set(position[0], position[1], position[2]), quaternion, new THREE.Vector3(1, 1, 1));
}

const quaternionOf = (rotation: Vec3): THREE.Quaternion =>
  new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2]));

/**
 * Matrix of the wrapper group around the (already final) entity at progress `t`: identity at t = 1.
 * created → spring grow about the pivot (height lags the footprint for solids); modified with a pose change → the
 * entity travels from its previous pose (wrapper = M(t)·M_final⁻¹); other edits → a short pulse.
 */
export function transitionMatrix(
  out: THREE.Matrix4,
  transition: EntityTransition,
  entity: Entity,
  t: number,
  planar: boolean,
): THREE.Matrix4 {
  if (t >= 1) return out.identity();
  if (transition.change === 'created') {
    const footprint = springGrow(Math.min(1, t * 1.35));
    const height = planar ? footprint : springGrow(t);
    return scaleAbout(out, transition.pivot, footprint, footprint, height);
  }
  if (transition.poseTween && transition.before !== undefined) {
    const k = easeInOutCubic(t);
    const from = transition.before;
    const position: Vec3 = [
      from.position[0] + (entity.position[0] - from.position[0]) * k,
      from.position[1] + (entity.position[1] - from.position[1]) * k,
      from.position[2] + (entity.position[2] - from.position[2]) * k,
    ];
    const finalQuaternion = quaternionOf(entity.rotation);
    scratch.q.copy(quaternionOf(from.rotation)).slerp(finalQuaternion, k);
    poseMatrix(out, position, scratch.q);
    return out.multiply(poseMatrix(scratch.b, entity.position, finalQuaternion).invert());
  }
  const pulse = 1 + 0.07 * Math.sin(Math.PI * t) * (1 - t);
  return scaleAbout(out, transition.pivot, pulse, pulse, pulse);
}

/** Ghost of a removed entity: shrinks toward its centre while rising; a replaced one just swells slightly. */
export function ghostMatrix(out: THREE.Matrix4, mode: 'removed' | 'replaced', center: Vec3, rise: number, t: number): THREE.Matrix4 {
  if (mode === 'replaced') {
    const swell = 1 + 0.04 * easeOutCubic(t);
    return scaleAbout(out, center, swell, swell, swell);
  }
  const k = easeInOutCubic(t);
  const shrink = 1 - 0.45 * k;
  scaleAbout(out, center, shrink, shrink, shrink);
  return out.premultiply(scratch.a.makeTranslation(0, 0, rise * k));
}

export function ghostOpacity(mode: 'removed' | 'replaced', t: number): number {
  return (mode === 'removed' ? 0.85 : 0.55) * (1 - easeOutCubic(t));
}
