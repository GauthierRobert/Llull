import { entityOfKind } from '../entity/entityOfKind';
import type { CadDocument, InstanceEntity, Joint, JointMateRef, DriveRelation, Vec3 } from '../../model/types';
import { resolveNumeric } from '../parametric/expression';
import { axisVector } from '../../lib/axis';
import { topologicalSort } from '../../lib/topologicalSort';
import { add3, scale3, sub3 } from '../../lib/vec3';
import { applyMat3, eulerFromMat, matFromAxisAngle, matFromEulerXYZ, mulMat3, type Mat3 } from '../../lib/axisRotation';

/** A rigid motion p ↦ rotation·p + translation (world frame). */
interface RigidMotion {
  readonly rotation: Mat3;
  readonly translation: Vec3;
}

const REST: RigidMotion = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] };

const moveBy = (motion: RigidMotion, p: Vec3): Vec3 => add3(applyMat3(motion.rotation, p), motion.translation);

function unit(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? scale3(v, 1 / length) : v;
}

/** Joints ordered so that a joint whose `a` instance is moved by another joint comes after that joint (cycles keep input order). */
function parentFirst(joints: readonly Joint[]): Joint[] {
  const ordered: Joint[] = [];
  let pending = [...joints];
  while (pending.length > 0) {
    const ready = pending.filter((joint) => !pending.some((other) => other !== joint && other.b.instanceId === joint.a.instanceId));
    const next = ready.length > 0 ? ready : pending.slice(0, 1);
    ordered.push(...next);
    pending = pending.filter((joint) => !next.includes(joint));
  }
  return ordered;
}

/** Resolve a JointMateRef to the InstanceEntity, returning null on missing/wrong kind. */
function resolveInstance(ref: JointMateRef, doc: CadDocument): InstanceEntity | null {
  const found = entityOfKind(doc, ref.instanceId, ['instance']);
  return typeof found === 'string' ? null : found;
}

/** Joint ids ordered driver before driven; joints on a drive cycle are omitted. */
function driveOrder(driveRelations: Record<string, DriveRelation>): string[] {
  const relations = Object.values(driveRelations);
  const jointIds = new Set(relations.flatMap((dr) => [dr.driver, dr.driven]));
  return topologicalSort(
    jointIds,
    relations.map((dr): [string, string] => [dr.driver, dr.driven]),
  ).sorted;
}

/**
 * Check whether adding a drive relation from `driverJointId` to `drivenJointId` would create a cycle. Returns the cycle path as a string,
 * or null if no cycle.
 */
export function detectCycleOnAdd(
  driveRelations: Record<string, DriveRelation>,
  driverJointId: string,
  drivenJointId: string,
): string | null {
  // Temporarily build the graph with the new edge and run DFS from drivenJointId looking for driverJointId (which would form a cycle).
  const adj = new Map<string, string[]>();
  for (const dr of Object.values(driveRelations)) {
    if (!adj.has(dr.driver)) adj.set(dr.driver, []);
    adj.get(dr.driver)!.push(dr.driven);
  }
  // Add the proposed new edge
  if (!adj.has(driverJointId)) adj.set(driverJointId, []);
  adj.get(driverJointId)!.push(drivenJointId);
  // DFS from drivenJointId looking for driverJointId
  const visited = new Set<string>();
  const path: string[] = [drivenJointId];
  function dfs(current: string): boolean {
    if (current === driverJointId) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    for (const next of adj.get(current) ?? []) {
      path.push(next);
      if (dfs(next)) return true;
      path.pop();
    }
    return false;
  }
  if (dfs(drivenJointId)) return path.join(' → ');
  return null;
}

interface EvaluatedMotion {
  /** Resolved joint values (joint id → numeric value) after propagating drive relations. */
  resolvedJoints: Record<string, number>;
  /** New instance positions after applying joints. */
  instancePositions: Record<string, Vec3>;
  /** New instance rotations after applying joints. */
  instanceRotations: Record<string, Vec3>;
}

/**
 * Evaluate all joints + drive relations and compute new instance positions/rotations.
 *
 * 1. Collect base joint values (resolving expression strings via doc.parameters); a joint named in `overrides` takes the override value
 *   instead (used by motion_study sweeps).
 * 2. Topo-sort drive relations and propagate: driven = driver * ratio + offset (never into an overridden joint).
 * 3. Apply each joint (parent joints first) to instance b: b moves rigidly with a, then by the joint about / along the axis through a.
 *
 * Returns EvaluatedMotion. Never mutates doc.
 */
export function evaluateMotionInternal(doc: CadDocument, overrides: Readonly<Record<string, number>> = {}): EvaluatedMotion {
  // Step 1: collect base joint values
  const resolvedJoints: Record<string, number> = {};
  for (const [jid, joint] of Object.entries(doc.joints)) {
    const override = overrides[jid];
    if (override !== undefined) {
      resolvedJoints[jid] = override;
      continue;
    }
    const rawValue = joint.kind === 'revolute' ? joint.angle : joint.displacement;
    resolvedJoints[jid] = resolveNumeric(rawValue, doc.parameters) ?? rawValue;
  }
  // Step 2: propagate drive relations in topo order
  const sortedJoints = driveOrder(doc.driveRelations);
  // Build a lookup: driven joint id → drive relation that drives it
  const drivenBy = new Map<string, DriveRelation>();
  for (const dr of Object.values(doc.driveRelations)) drivenBy.set(dr.driven, dr);
  for (const jid of sortedJoints) {
    const dr = drivenBy.get(jid);
    if (!dr) continue;
    const driverValue = resolvedJoints[dr.driver];
    if (driverValue === undefined || overrides[jid] !== undefined) continue;
    resolvedJoints[jid] = driverValue * dr.ratio + (dr.offset ?? 0);
  }
  // Step 3: apply joints parent-first. Each instance carries the rigid motion of the joint chain above it: b moves with a (axis
  // included), then turns about the axis through a's moved origin (revolute) or sits at a's moved origin + axis·value (prismatic).
  const instancePositions: Record<string, Vec3> = {};
  const instanceRotations: Record<string, Vec3> = {};
  const motions = new Map<string, RigidMotion>();
  for (const joint of parentFirst(Object.values(doc.joints))) {
    const instanceA = resolveInstance(joint.a, doc);
    const instanceB = resolveInstance(joint.b, doc);
    if (!instanceA || !instanceB) continue;
    const value = resolvedJoints[joint.id] ?? 0;
    const carried = motions.get(joint.a.instanceId) ?? REST;
    const base = motions.get(joint.b.instanceId) ?? carried;
    const pivot = moveBy(carried, instanceA.position);
    const axis = unit(applyMat3(carried.rotation, axisVector(joint.axis)));
    let motion: RigidMotion;
    if (joint.kind === 'revolute') {
      const turn = matFromAxisAngle(axis, value);
      motion = { rotation: mulMat3(turn, base.rotation), translation: add3(applyMat3(turn, sub3(base.translation, pivot)), pivot) };
    } else {
      const target = add3(pivot, scale3(axis, value));
      motion = { rotation: base.rotation, translation: sub3(target, applyMat3(base.rotation, instanceB.position)) };
    }
    motions.set(joint.b.instanceId, motion);
    instancePositions[joint.b.instanceId] = moveBy(motion, instanceB.position);
    instanceRotations[joint.b.instanceId] = eulerFromMat(mulMat3(motion.rotation, matFromEulerXYZ(instanceB.rotation)));
  }
  return { resolvedJoints, instancePositions, instanceRotations };
}
