import * as THREE from 'three';
import type { Animation, Vec3 } from '@core/model/types';

/** Frame scalar at `phase` s: spin = speed·phase, oscillate = amplitude·sin(2π·frequency·phase). Radians for rotation, world units for position. */
export function evaluateAnimationScalar(anim: Pick<Animation, 'mode' | 'speed' | 'amplitude' | 'frequency'>, phase: number): number {
  if (anim.mode === 'spin') return anim.speed * phase;
  return anim.amplitude * Math.sin(2 * Math.PI * anim.frequency * phase);
}

function rotateAboutPivotInPlace(point: THREE.Vector3, rotation: THREE.Quaternion, pivot: THREE.Vector3): THREE.Vector3 {
  return point.sub(pivot).applyQuaternion(rotation).add(pivot);
}

export interface AnimatedPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

/** Reused temporaries: a per-frame caller allocates nothing. */
interface PoseScratch {
  readonly euler: THREE.Euler;
  readonly step: THREE.Quaternion;
  readonly offset: THREE.Vector3;
}

export function createPoseScratch(): PoseScratch {
  return { euler: new THREE.Euler(), step: new THREE.Quaternion(), offset: new THREE.Vector3() };
}

export interface AnimationContribution {
  /** 'rotation' also rotates the position about `pivot`. */
  channel: 'rotation' | 'position';
  axis: THREE.Vector3;
  scalar: number;
  pivot: THREE.Vector3;
}

/**
 * Base pose (position + XYZ euler) after ordered contributions: rotation premultiplies (later layers on top) and
 * rotates the position about its pivot; position adds axis·scalar. @invariant mutates only `pose` and `scratch`
 */
export function composeAnimatedPoseInto(
  pose: AnimatedPose,
  basePosition: Vec3,
  baseRotationEulerXYZ: Vec3,
  contributions: ReadonlyArray<AnimationContribution>,
  scratch: PoseScratch,
): void {
  pose.position.set(basePosition[0], basePosition[1], basePosition[2]);
  scratch.euler.set(baseRotationEulerXYZ[0], baseRotationEulerXYZ[1], baseRotationEulerXYZ[2], 'XYZ');
  pose.quaternion.setFromEuler(scratch.euler);

  for (const contrib of contributions) {
    if (contrib.channel === 'rotation') {
      scratch.step.setFromAxisAngle(contrib.axis, contrib.scalar);
      pose.quaternion.premultiply(scratch.step);
      rotateAboutPivotInPlace(pose.position, scratch.step, contrib.pivot);
    } else {
      pose.position.add(scratch.offset.copy(contrib.axis).multiplyScalar(contrib.scalar));
    }
  }
}

/** Closed loop with its cumulative arc length: `lengths[i]` = distance from vertex 0 to vertex i, `lengths[n]` = the whole loop. */
export interface MeasuredLoop {
  readonly points: ReadonlyArray<Vec3>;
  readonly lengths: number[];
  /** Unit Newell normal of the loop (+Z when degenerate): the half-turn axis of a planar chain. */
  readonly normal: Vec3;
}

export function measureLoop(points: ReadonlyArray<Vec3>): MeasuredLoop {
  const lengths = [0];
  let [nx, ny, nz] = [0, 0, 0];
  let total = 0;
  points.forEach((point, i) => {
    const next = points[(i + 1) % points.length] ?? point;
    total += Math.hypot(next[0] - point[0], next[1] - point[1], next[2] - point[2]);
    lengths.push(total);
    nx += (point[1] - next[1]) * (point[2] + next[2]);
    ny += (point[2] - next[2]) * (point[0] + next[0]);
    nz += (point[0] - next[0]) * (point[1] + next[1]);
  });
  const size = Math.hypot(nx, ny, nz);
  return { points, lengths, normal: size > 1e-12 ? [nx / size, ny / size, nz / size] : [0, 0, 1] };
}

/** Arc length (from vertex 0) of the loop point nearest to `p`. */
export function nearestLoopDistance(loop: MeasuredLoop, p: Vec3): number {
  const { points, lengths } = loop;
  let best = Infinity;
  let bestDistance = 0;
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length] ?? a;
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const lengthSquared = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const raw = lengthSquared > 0 ? ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / lengthSquared : 0;
    const t = Math.min(1, Math.max(0, raw));
    const gap = Math.hypot(a[0] + d[0] * t - p[0], a[1] + d[1] * t - p[1], a[2] + d[2] * t - p[2]);
    if (gap < best) {
      best = gap;
      bestDistance = (lengths[i] ?? 0) + t * Math.sqrt(lengthSquared);
    }
  });
  return bestDistance;
}

/** Point and unit tangent at arc length `s` (wrapped round the loop) into `point` / `tangent`. */
export function writeLoopFrame(loop: MeasuredLoop, s: number, point: THREE.Vector3, tangent: THREE.Vector3): void {
  const { points, lengths } = loop;
  const total = lengths[points.length] ?? 0;
  const wrapped = total > 0 ? ((s % total) + total) % total : 0;
  let i = 0;
  while (i < points.length - 1 && (lengths[i + 1] ?? 0) < wrapped) i += 1;
  const a = points[i] ?? [0, 0, 0];
  const b = points[(i + 1) % points.length] ?? a;
  const span = (lengths[i + 1] ?? 0) - (lengths[i] ?? 0);
  const t = span > 0 ? (wrapped - (lengths[i] ?? 0)) / span : 0;
  point.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
  tangent.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (tangent.lengthSq() > 0) tangent.normalize();
}

/** Reused temporaries of `writeFollowPathContributions`. */
export interface LoopScratch {
  readonly startPoint: THREE.Vector3;
  readonly startTangent: THREE.Vector3;
  readonly point: THREE.Vector3;
  readonly tangent: THREE.Vector3;
}

export function createLoopScratch(): LoopScratch {
  return { startPoint: new THREE.Vector3(), startTangent: new THREE.Vector3(), point: new THREE.Vector3(), tangent: new THREE.Vector3() };
}

/**
 * A member starting at arc length `start` (its nearest loop point, `nearestLoopDistance`) carried `travel` along the loop: `turn` rotates
 * it about its start loop point by the tangent change, then `shift` moves it from that point to the point `travel` further on.
 * @invariant mutates only `turn`, `shift` and `scratch`
 */
export function writeFollowPathContributions(
  loop: MeasuredLoop,
  start: number,
  travel: number,
  turn: AnimationContribution,
  shift: AnimationContribution,
  scratch: LoopScratch,
): void {
  writeLoopFrame(loop, start, scratch.startPoint, scratch.startTangent);
  writeLoopFrame(loop, start + travel, scratch.point, scratch.tangent);
  turn.channel = 'rotation';
  turn.pivot.copy(scratch.startPoint);
  turn.axis.crossVectors(scratch.startTangent, scratch.tangent);
  const sine = turn.axis.length();
  const cosine = scratch.startTangent.dot(scratch.tangent);
  if (sine > 1e-9) {
    turn.axis.divideScalar(sine);
    turn.scalar = Math.atan2(sine, cosine);
  } else {
    // Parallel tangents: no turn, or a half turn about the loop normal (exact for a planar chain).
    turn.axis.set(loop.normal[0], loop.normal[1], loop.normal[2]);
    turn.scalar = cosine < 0 ? Math.PI : 0;
  }
  shift.channel = 'position';
  shift.axis.subVectors(scratch.point, scratch.startPoint);
  shift.scalar = shift.axis.length();
  if (shift.scalar > 0) shift.axis.divideScalar(shift.scalar);
}
