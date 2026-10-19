/** Moving a document's rigid-body members to a simulated pose (render_motion). Pure: returns new entities, never edits the input. */

import type { CadDocument, Entity } from '../model/types';
import type { Vec3 } from '../model/vectors';
import { applyMat3, eulerFromMat, matFromEulerXYZ, mulMat3, type Mat3 } from '../lib/axisRotation';
import type { Quaternion } from './physicsEngine';

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
