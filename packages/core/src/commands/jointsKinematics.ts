import type {
  CadDocument,
  InstanceEntity,
  JointMateRef,
  DriveRelation,
  Vec3,
} from '../model/types';
import { resolveNumeric } from './expression';
import { axisVector } from '../lib/axis';
import { topologicalSort } from '../lib/topologicalSort';
import { add3, scale3, sub3 } from '../lib/vec3';

/**
 * Rotate a Vec3 about an axis by an angle (Rodrigues' rotation formula).
 * @pure
 */
function rotateAboutAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const [ux, uy, uz] = axis;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dot = v[0] * ux + v[1] * uy + v[2] * uz;
  // Rodrigues: v*cos + (axis×v)*sin + axis*(axis·v)*(1-cos)
  const crossX = uy * v[2] - uz * v[1];
  const crossY = uz * v[0] - ux * v[2];
  const crossZ = ux * v[1] - uy * v[0];
  return [
    v[0] * cos + crossX * sin + ux * dot * (1 - cos),
    v[1] * cos + crossY * sin + uy * dot * (1 - cos),
    v[2] * cos + crossZ * sin + uz * dot * (1 - cos),
  ];
}

/** Resolve a JointMateRef to the InstanceEntity, returning null on missing/wrong kind. */
function resolveInstance(ref: JointMateRef, doc: CadDocument): InstanceEntity | null {
  const e = doc.entities[ref.instanceId];
  if (!e || e.kind !== 'instance') return null;
  return e;
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
 * Check whether adding a drive relation from `driverJointId` to `drivenJointId`
 * would create a cycle. Returns the cycle path as a string, or null if no cycle.
 * @pure
 */
export function detectCycleOnAdd(
  driveRelations: Record<string, DriveRelation>,
  driverJointId: string,
  drivenJointId: string,
): string | null {
  // Temporarily build the graph with the new edge and run DFS from drivenJointId
  // looking for driverJointId (which would form a cycle).
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
 * 1. Collect base joint values (resolving expression strings via doc.parameters); a joint named
 *    in `overrides` takes the override value instead (used by motion_study sweeps).
 * 2. Topo-sort drive relations and propagate: driven = driver * ratio + offset (never into an
 *    overridden joint).
 * 3. Apply each joint to instance b's position/rotation relative to instance a.
 *
 * Returns EvaluatedMotion. Never mutates doc.
 *
 * @pure
 */
export function evaluateMotionInternal(
  doc: CadDocument,
  overrides: Readonly<Record<string, number>> = {},
): EvaluatedMotion {
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
  for (const dr of Object.values(doc.driveRelations)) {
    drivenBy.set(dr.driven, dr);
  }

  for (const jid of sortedJoints) {
    const dr = drivenBy.get(jid);
    if (!dr) continue;
    const driverValue = resolvedJoints[dr.driver];
    if (driverValue === undefined || overrides[jid] !== undefined) continue;
    resolvedJoints[jid] = driverValue * dr.ratio + (dr.offset ?? 0);
  }

  // Step 3: apply joints to instance transforms
  const instancePositions: Record<string, Vec3> = {};
  const instanceRotations: Record<string, Vec3> = {};

  for (const joint of Object.values(doc.joints)) {
    const instanceA = resolveInstance(joint.a, doc);
    const instanceB = resolveInstance(joint.b, doc);
    if (!instanceA || !instanceB) continue;

    const value = resolvedJoints[joint.id] ?? 0;
    const axisVec = axisVector(joint.axis);

    const bId = joint.b.instanceId;
    const bRot: Vec3 = instanceRotations[bId] ?? instanceB.rotation;
    if (joint.kind === 'revolute') {
      // Rotate b about the axis through a's position; b's Euler angles gain value * axis.
      const pivot = instanceA.position;
      const offset = sub3(instancePositions[bId] ?? instanceB.position, pivot);
      instancePositions[bId] = add3(pivot, rotateAboutAxis(offset, axisVec, value));
      instanceRotations[bId] = add3(bRot, scale3(axisVec, value));
    } else {
      // Prismatic: b slides along the axis from a's position; rotation unchanged.
      instancePositions[bId] = add3(instanceA.position, scale3(axisVec, value));
      instanceRotations[bId] = bRot;
    }
  }

  return { resolvedJoints, instancePositions, instanceRotations };
}
