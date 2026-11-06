/**
 * Evaluating `document.animations` (spin / oscillate clips) at a time: the one implementation behind the viewport player and render_animation.
 * Pure arithmetic on tuples, no three.js. Rotation clips turn the target about their pivot, premultiplied in document order; position clips add axis · scalar.
 */

import type { Animation, CadDocument, Entity } from '../model/types';
import type { Vec3 } from '../model/vectors';
import { eulerFromMat } from '../lib/axisRotation';
import { matFromQuaternion } from './bodyPose';

/** One clip's contribution to an entity at one instant. Mutable so a per-frame caller can pool them. */
export interface AnimationContribution {
  channel: 'rotation' | 'position';
  /** Unit direction (rotation: axle; position: translation). */
  axis: [number, number, number];
  /** Radians (rotation) or document units (position). */
  scalar: number;
  /** Rotation only: world pivot. */
  pivot: [number, number, number];
}

/** An entity pose: position and the unit quaternion in [x, y, z, w] order (the three.js order). Written in place. */
export interface AnimatedPose {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

export const createAnimatedPose = (): AnimatedPose => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] });

export const createContribution = (): AnimationContribution => ({ channel: 'rotation', axis: [0, 0, 1], scalar: 0, pivot: [0, 0, 0] });

/** Clip scalar after `phase` seconds: spin = speed·phase, oscillate = amplitude·sin(2π·frequency·phase). Radians for rotation, document units for position. */
export function animationScalar(anim: Pick<Animation, 'mode' | 'speed' | 'amplitude' | 'frequency'>, phase: number): number {
  if (anim.mode === 'spin') return anim.speed * phase;
  return anim.amplitude * Math.sin(2 * Math.PI * anim.frequency * phase);
}

/** Entity ids a clip drives: its entity, or the members of its group. */
export function animationMembers(anim: Animation, groups: CadDocument['groups']): readonly string[] {
  return anim.targetKind === 'entity' ? [anim.targetId] : (groups[anim.targetId]?.memberIds ?? []);
}

/** Writes the unit direction of `v` into `target` (+Z for a near-zero vector). */
function writeUnitAxis(target: [number, number, number], v: Vec3): void {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length < 1e-9) [target[0], target[1], target[2]] = [0, 0, 1];
  else [target[0], target[1], target[2]] = [v[0] / length, v[1] / length, v[2] / length];
}

/** Writes the clip's pivot: its own, else the position of its entity target, else the centroid of its group members. */
function writePivot(
  target: [number, number, number],
  anim: Animation,
  members: readonly string[],
  entities: CadDocument['entities'],
): void {
  if (anim.pivot) {
    [target[0], target[1], target[2]] = anim.pivot;
    return;
  }
  if (anim.targetKind === 'entity') {
    const position = entities[anim.targetId]?.position ?? [0, 0, 0];
    [target[0], target[1], target[2]] = position;
    return;
  }
  let [x, y, z, count] = [0, 0, 0, 0];
  for (const id of members) {
    const position = entities[id]?.position;
    if (position === undefined) continue;
    x += position[0];
    y += position[1];
    z += position[2];
    count += 1;
  }
  const divisor = Math.max(count, 1);
  [target[0], target[1], target[2]] = [x / divisor, y / divisor, z / divisor];
}

/** Fills `target` with the contribution of `anim` after `phase` seconds, given the document's `entities` (for the default pivot). */
export function fillAnimationContribution(
  target: AnimationContribution,
  anim: Animation,
  phase: number,
  members: readonly string[],
  entities: CadDocument['entities'],
): void {
  target.channel = anim.channel;
  target.scalar = animationScalar(anim, phase);
  writeUnitAxis(target.axis, anim.axis);
  if (anim.channel === 'rotation') writePivot(target.pivot, anim, members, entities);
}

/** three.js `Euler(x, y, z, 'XYZ')` as a quaternion [x, y, z, w]. */
function writeEulerQuaternion(target: AnimatedPose['quaternion'], euler: Vec3): void {
  const [c1, c2, c3] = [Math.cos(euler[0] / 2), Math.cos(euler[1] / 2), Math.cos(euler[2] / 2)];
  const [s1, s2, s3] = [Math.sin(euler[0] / 2), Math.sin(euler[1] / 2), Math.sin(euler[2] / 2)];
  target[0] = s1 * c2 * c3 + c1 * s2 * s3;
  target[1] = c1 * s2 * c3 - s1 * c2 * s3;
  target[2] = c1 * c2 * s3 + s1 * s2 * c3;
  target[3] = c1 * c2 * c3 - s1 * s2 * s3;
}

/**
 * Pose (position + Euler XYZ rotation) after ordered contributions: a rotation premultiplies the orientation and turns the position about
 * its pivot; a position clip adds axis · scalar.
 * @invariant mutates only `pose`; allocates nothing
 */
export function composeAnimatedPoseInto(
  pose: AnimatedPose,
  basePosition: Vec3,
  baseRotationEulerXYZ: Vec3,
  contributions: readonly AnimationContribution[],
): void {
  const { position, quaternion } = pose;
  [position[0], position[1], position[2]] = basePosition;
  writeEulerQuaternion(quaternion, baseRotationEulerXYZ);
  for (const contribution of contributions) {
    const { axis, scalar } = contribution;
    if (contribution.channel === 'position') {
      position[0] += axis[0] * scalar;
      position[1] += axis[1] * scalar;
      position[2] += axis[2] * scalar;
      continue;
    }
    const sine = Math.sin(scalar / 2);
    const [ax, ay, az, aw] = [axis[0] * sine, axis[1] * sine, axis[2] * sine, Math.cos(scalar / 2)];
    const [bx, by, bz, bw] = quaternion;
    quaternion[0] = aw * bx + ax * bw + ay * bz - az * by;
    quaternion[1] = aw * by - ax * bz + ay * bw + az * bx;
    quaternion[2] = aw * bz + ax * by - ay * bx + az * bw;
    quaternion[3] = aw * bw - ax * bx - ay * by - az * bz;
    const [vx, vy, vz] = [position[0] - contribution.pivot[0], position[1] - contribution.pivot[1], position[2] - contribution.pivot[2]];
    const [tx, ty, tz] = [2 * (ay * vz - az * vy), 2 * (az * vx - ax * vz), 2 * (ax * vy - ay * vx)];
    position[0] = contribution.pivot[0] + vx + aw * tx + (ay * tz - az * ty);
    position[1] = contribution.pivot[1] + vy + aw * ty + (az * tx - ax * tz);
    position[2] = contribution.pivot[2] + vz + aw * tz + (ax * ty - ay * tx);
  }
}

/** Pose of one entity placed by clips: position and Euler XYZ rotation (radians), as an entity stores them. */
export interface AnimatedPlacement {
  readonly position: Vec3;
  readonly rotation: Vec3;
}

/**
 * Where every entity driven by an `auto` clip sits `t` seconds into the run; entities no running clip drives are left out. `click` clips never play here.
 * @invariant pure; clips of one entity compose in document order; a clip with no existing member entity drives nothing
 */
export function animationPoseAt(doc: CadDocument, t: number): Record<string, AnimatedPlacement> {
  const byEntity = new Map<string, AnimationContribution[]>();
  for (const anim of Object.values(doc.animations)) {
    if (anim.trigger !== 'auto') continue;
    const members = animationMembers(anim, doc.groups);
    const contribution = createContribution();
    fillAnimationContribution(contribution, anim, t, members, doc.entities);
    for (const id of members) {
      if (doc.entities[id] === undefined) continue;
      byEntity.set(id, [...(byEntity.get(id) ?? []), contribution]);
    }
  }
  const pose = createAnimatedPose();
  const placements: Record<string, AnimatedPlacement> = {};
  for (const [id, contributions] of byEntity) {
    const entity = doc.entities[id] as Entity;
    composeAnimatedPoseInto(pose, entity.position, entity.rotation, contributions);
    const [x, y, z, w] = pose.quaternion;
    const [rx, ry, rz] = eulerFromMat(matFromQuaternion([w, x, y, z]));
    placements[id] = { position: [pose.position[0], pose.position[1], pose.position[2]], rotation: [rx + 0, ry + 0, rz + 0] };
  }
  return placements;
}

/** Copy of `doc` whose clip-driven entities sit where `animationPoseAt(doc, t)` puts them; the animations stay in it. */
export function documentAtAnimation(doc: CadDocument, t: number): CadDocument {
  const entities: CadDocument['entities'] = { ...doc.entities };
  for (const [id, placement] of Object.entries(animationPoseAt(doc, t))) {
    const entity = doc.entities[id];
    if (entity !== undefined) entities[id] = { ...entity, position: placement.position, rotation: placement.rotation };
  }
  return { ...doc, entities };
}
