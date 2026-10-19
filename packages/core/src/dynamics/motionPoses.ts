/**
 * Body poses along a simulated run for the motion-clearance check (PHY-21 TR-FPR-10): interpolation between samples, motion
 * detection, travel bounds and the rigid transform that carries one start-pose mesh into another's frame.
 * @invariant pure; poses between two samples follow the screw motion between them (exact for a rotation about a fixed axis; a pure
 *   translation is a lerp) with slerp orientation
 */

import type { Vec3 } from '../model/vectors';
import { applyMat3, matFromAxisAngle, mulMat3, type Mat3 } from '../lib/axisRotation';
import { add3, cross3, dot3, lerp3, scale3, sub3 } from '../lib/vec3';
import type { RigidTransform } from '../geometry/meshBvh';
import { type BodyPoseAt, matFromQuaternion } from './bodyPose';
import type { Quaternion } from './physicsEngine';

/** Centre-of-mass positions (document units) and rotations from the start pose of one body, one entry per sample. */
export interface PoseTrack {
  readonly position: readonly Vec3[];
  readonly orientation: readonly Quaternion[];
}

/** Pose of a part that never moves: the identity motion. */
export const STATIC_POSE: BodyPoseAt = { start: [0, 0, 0], position: [0, 0, 0], orientation: [1, 0, 0, 0] };

const TINY = 1e-9;

function slerp(a: Quaternion, b: Quaternion, fraction: number): Quaternion {
  const raw = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = raw < 0 ? -1 : 1;
  const cos = Math.min(1, raw * sign);
  const angle = Math.acos(cos);
  const sin = Math.sin(angle);
  const [wa, wb] =
    sin < 1e-9 ? [1 - fraction, fraction * sign] : [Math.sin((1 - fraction) * angle) / sin, (Math.sin(fraction * angle) / sin) * sign];
  const q = [0, 1, 2, 3].map((k) => wa * (a[k] ?? 0) + wb * (b[k] ?? 0));
  const norm = Math.hypot(...q) || 1;
  return [(q[0] ?? 0) / norm, (q[1] ?? 0) / norm, (q[2] ?? 0) / norm, (q[3] ?? 0) / norm];
}

/** Rotation (world) carrying orientation `a` to `b`: axis (unit) and angle in [0, pi]; null when they are the same. */
function relativeRotation(a: Quaternion, b: Quaternion): { axis: Vec3; angle: number } | null {
  // b * conj(a)
  const [aw, ax, ay, az] = [a[0], -a[1], -a[2], -a[3]];
  const [bw, bx, by, bz] = b;
  const w = bw * aw - bx * ax - by * ay - bz * az;
  const v: Vec3 = [bw * ax + bx * aw + by * az - bz * ay, bw * ay - bx * az + by * aw + bz * ax, bw * az + bx * ay - by * ax + bz * aw];
  const sign = w < 0 ? -1 : 1;
  const sine = Math.hypot(...v);
  if (sine < 1e-12) return null;
  return { axis: [(v[0] * sign) / sine, (v[1] * sign) / sine, (v[2] * sign) / sine], angle: 2 * Math.atan2(sine, w * sign) };
}

/**
 * Centre of mass a `fraction` of the way along the screw motion from (here, a) to (next, b): exact for a body turning about a fixed axis
 * (a crank), where a straight lerp of the centre would cut the chord of its arc.
 */
function screwPosition(here: Vec3, next: Vec3, a: Quaternion, b: Quaternion, fraction: number): Vec3 {
  const lerped = lerp3(here, next, fraction);
  const rotation = relativeRotation(a, b);
  if (rotation === null || rotation.angle < 1e-9) return lerped;
  const { axis, angle } = rotation;
  const turn = matFromAxisAngle(axis, angle);
  const step = sub3(next, applyMat3(turn, here));
  const along = scale3(axis, dot3(axis, step));
  const across = sub3(step, along);
  // fixed point of the planar part: (I - R) c = across, c in the plane normal to the axis
  const centre = add3(scale3(across, 0.5), scale3(cross3(axis, across), 0.5 / Math.tan(angle / 2)));
  const partial = applyMat3(matFromAxisAngle(axis, angle * fraction), sub3(here, centre));
  return add3(add3(partial, centre), scale3(along, fraction));
}

/** Pose of a body at sample `index` plus `fraction` (0..1) of the way to the next sample (screw interpolation, slerp orientation). */
export function poseAt(track: PoseTrack, index: number, fraction: number): BodyPoseAt {
  const start = track.position[0] ?? [0, 0, 0];
  const here = track.position[index] ?? start;
  const hereQ = track.orientation[index] ?? STATIC_POSE.orientation;
  if (fraction <= 0 || index + 1 >= track.position.length) return { start, position: here, orientation: hereQ };
  const next = track.position[index + 1] ?? here;
  const nextQ = track.orientation[index + 1] ?? hereQ;
  return { start, position: screwPosition(here, next, hereQ, nextQ, fraction), orientation: slerp(hereQ, nextQ, fraction) };
}

/** Whether the body leaves its start pose at any sample. */
export function isMoving(track: PoseTrack): boolean {
  const start = track.position[0];
  if (start === undefined) return false;
  const moved = track.position.some((p) => Math.hypot(p[0] - start[0], p[1] - start[1], p[2] - start[2]) > TINY);
  return moved || track.orientation.some((q) => Math.abs(q[0]) < 1 - TINY);
}

/** Upper bound on how far any point at distance `radius` from the centre of mass travels between samples `index` and `index + 1`. */
export function travelBound(track: PoseTrack, index: number, radius: number): number {
  const [p, q] = [track.position[index], track.position[index + 1]];
  const [a, b] = [track.orientation[index], track.orientation[index + 1]];
  if (p === undefined || q === undefined || a === undefined || b === undefined) return 0;
  const angle = 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
  return Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) + angle * radius;
}

const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/** Motion of mesh B (its start-pose points) into the start-pose frame of mesh A, with A and B carried by poses `a` and `b`. */
export function relativeTransform(a: BodyPoseAt, b: BodyPoseAt): RigidTransform {
  const rotationA = matFromQuaternion(a.orientation);
  const rotationB = matFromQuaternion(b.orientation);
  const carried = applyMat3(rotationB, b.start);
  const inWorld: Vec3 = [
    b.position[0] - a.position[0] - carried[0],
    b.position[1] - a.position[1] - carried[1],
    b.position[2] - a.position[2] - carried[2],
  ];
  const back = applyMat3(transpose(rotationA), inWorld);
  return {
    rotation: mulMat3(transpose(rotationA), rotationB),
    translation: [back[0] + a.start[0], back[1] + a.start[1], back[2] + a.start[2]],
  };
}
