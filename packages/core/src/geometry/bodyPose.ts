/** Moving a document's rigid-body members to a simulated pose (render_motion) and interpolating recorded poses in time. Pure: returns new entities, never edits the input. */

import type { CadDocument, Entity } from '../model/types';
import type { Quaternion, Vec3 } from '../model/vectors';
import { applyMat3, eulerFromMat, matFromAxisAngle, matFromEulerXYZ, mulMat3, type Mat3 } from '../lib/axisRotation';
import { add3, cross3, dot3, lerp3, scale3, sub3 } from '../lib/vec3';

/** Rotation matrix of the unit quaternion [w, x, y, z] (normalized here). */
export function matFromQuaternion(q: Quaternion): Mat3 {
  const norm = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const [w, x, y, z] = [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm];
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    2 * (x * y + w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z - w * x),
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    1 - 2 * (x * x + y * y),
  ];
}

/** Euler XYZ angles (degrees) of a quaternion rotation, -0 normalized to 0. */
export function eulerDegOf(q: Quaternion): Vec3 {
  const [x, y, z] = eulerFromMat(matFromQuaternion(q));
  const deg = (rad: number): number => Math.round(((rad * 180) / Math.PI) * 1e6) / 1e6 + 0;
  return [deg(x), deg(y), deg(z)];
}

/** One body at one instant: centre of mass at t = 0 and now (document units) and its rotation since t = 0. */
export interface BodyPoseAt {
  readonly start: Vec3;
  readonly position: Vec3;
  readonly orientation: Quaternion;
}

/** `entity` rigidly moved with its body: rotated by the body rotation about the start centre of mass, then translated with it. */
function movedEntity(entity: Entity, pose: BodyPoseAt, rotation: Mat3): Entity {
  const offset: Vec3 = [entity.position[0] - pose.start[0], entity.position[1] - pose.start[1], entity.position[2] - pose.start[2]];
  const turned = applyMat3(rotation, offset);
  const [rx, ry, rz] = eulerFromMat(mulMat3(rotation, matFromEulerXYZ(entity.rotation)));
  return {
    ...entity,
    position: [pose.position[0] + turned[0], pose.position[1] + turned[1], pose.position[2] + turned[2]],
    rotation: [rx + 0, ry + 0, rz + 0],
  };
}

/** Copy of `doc` whose rigid-body member entities sit at `poses` (body id -> pose); entities of other bodies are untouched. */
export function documentAtPose(doc: CadDocument, poses: Readonly<Record<string, BodyPoseAt>>): CadDocument {
  const entities: CadDocument['entities'] = { ...doc.entities };
  for (const [bodyId, pose] of Object.entries(poses)) {
    const rotation = matFromQuaternion(pose.orientation);
    for (const entityId of doc.dynamics?.bodies[bodyId]?.entityIds ?? []) {
      const entity = doc.entities[entityId];
      if (entity !== undefined) entities[entityId] = movedEntity(entity, pose, rotation);
    }
  }
  return { ...doc, entities };
}

/** World point rigidly attached to a body: `point` (document units, at the start pose) carried to the body's pose. */
export function pointAtPose(point: Vec3, pose: BodyPoseAt): Vec3 {
  const turned = applyMat3(matFromQuaternion(pose.orientation), [
    point[0] - pose.start[0],
    point[1] - pose.start[1],
    point[2] - pose.start[2],
  ]);
  return [pose.position[0] + turned[0], pose.position[1] + turned[1], pose.position[2] + turned[2]];
}

/** Every body's pose at sample `index` of a recorded run (`SimulationData.poses`); bodies without that sample are left out. */
export function posesAtSample(
  poses: { readonly bodies: Readonly<Record<string, { readonly position: readonly Vec3[]; readonly orientation: readonly Quaternion[] }>> },
  index: number,
): Record<string, BodyPoseAt> {
  const result: Record<string, BodyPoseAt> = {};
  for (const [id, track] of Object.entries(poses.bodies)) {
    const start = track.position[0];
    const position = track.position[index];
    const orientation = track.orientation[index];
    if (start !== undefined && position !== undefined && orientation !== undefined) result[id] = { start, position, orientation };
  }
  return result;
}

/** Centre-of-mass positions (document units) and rotations from the start pose of one body, one entry per sample. */
export interface PoseTrack {
  readonly position: readonly Vec3[];
  readonly orientation: readonly Quaternion[];
}

const IDENTITY_ORIENTATION: Quaternion = [1, 0, 0, 0];

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

/**
 * Pose of a body at sample `index` plus `fraction` of the way to the next sample (screw interpolation, slerp orientation).
 * @invariant fraction is clamped to [0, 1]; the relative rotation of a step is taken on the shortest arc (at most pi), so the recording must resolve less than pi of rotation per sample step
 */
export function poseAtFraction(track: PoseTrack, index: number, requested: number): BodyPoseAt {
  const start = track.position[0] ?? [0, 0, 0];
  const here = track.position[index] ?? start;
  const hereQ = track.orientation[index] ?? IDENTITY_ORIENTATION;
  const fraction = Math.min(1, requested);
  if (fraction <= 0 || index + 1 >= track.position.length) return { start, position: here, orientation: hereQ };
  const next = track.position[index + 1] ?? here;
  const nextQ = track.orientation[index + 1] ?? hereQ;
  return { start, position: screwPosition(here, next, hereQ, nextQ, fraction), orientation: slerp(hereQ, nextQ, fraction) };
}

/** Recorded run (`SimulationData.poses`): sample times and one track per body. */
export interface RecordedPoses {
  readonly times: readonly number[];
  readonly bodies: Readonly<Record<string, PoseTrack>>;
}

/** Instants closer than this to a recorded sample are that sample (bit-exact). */
const SAMPLE_SNAP_S = 1e-12;

/**
 * Every body's pose at time `time` (seconds) of a recorded run: the bracketing samples blended by poseAtFraction (screw motion of the
 * centre, slerp orientation); the sample itself when `time` is within 1e-12 s of it; clamped to the first / last sample outside the run.
 * @invariant sampleRate must resolve less than pi of body rotation per sample step (shortest-arc interpolation); pure; time = a sample time returns that sample's pose unchanged; bodies without samples are left out
 */
export function posesAtTime(poses: RecordedPoses, time: number): Record<string, BodyPoseAt> {
  const { times } = poses;
  const last = times.length - 1;
  if (last < 0) return {};
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if ((times[mid] ?? 0) <= time) low = mid;
    else high = mid;
  }
  const t0 = times[low] ?? 0;
  const t1 = times[high] ?? t0;
  let index = low;
  let fraction = 0;
  if (time <= t0 + SAMPLE_SNAP_S) index = low;
  else if (time >= t1 - SAMPLE_SNAP_S) index = high;
  else fraction = (time - t0) / (t1 - t0);
  const result: Record<string, BodyPoseAt> = {};
  for (const [id, track] of Object.entries(poses.bodies)) {
    if (track.position[index] === undefined || track.orientation[index] === undefined) continue;
    result[id] = poseAtFraction(track, index, fraction);
  }
  return result;
}
