import type {
  CadDocument,
  InstanceEntity,
  JointMateRef,
  DriveRelation,
  Vec3,
} from '../model/types';
import { evaluateExpression } from './expression';
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Normalize a string axis shorthand ('x'|'y'|'z') to a Vec3 unit vector. */
function normalizeAxis(axis: 'x' | 'y' | 'z' | Vec3): Vec3 {
  if (axis === 'x') return [1, 0, 0];
  if (axis === 'y') return [0, 1, 0];
  if (axis === 'z') return [0, 0, 1];
  return axis;
}

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

/**
 * Resolve a joint value that may be a number or a parameter expression string.
 * Returns the resolved number, or null on resolution failure.
 */
export function resolveJointValue(raw: number | string, doc: CadDocument): number | null {
  if (typeof raw === 'number') return raw;
  const env: Record<string, number> = {};
  for (const [name, param] of Object.entries(doc.parameters)) {
    env[name] = param.value;
  }
  const result = evaluateExpression(raw, env);
  return result.ok ? result.value : null;
}

/** Validate that a string is a valid named axis shorthand or that the value is a Vec3. */
export function isValidAxis(v: unknown): v is 'x' | 'y' | 'z' | Vec3 {
  if (v === 'x' || v === 'y' || v === 'z') return true;
  if (!Array.isArray(v) || v.length !== 3) return false;
  return (v as unknown[]).every((c) => typeof c === 'number' && Number.isFinite(c));
}

/** Validate a JointMateRef shape. */
export function isValidMateRef(v: unknown): v is { instanceId: string; frame?: string } {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj['instanceId'] !== 'string' || obj['instanceId'].length === 0) return false;
  if (obj['frame'] !== undefined) {
    const f = obj['frame'];
    if (f !== 'origin' && f !== 'axis-x' && f !== 'axis-y' && f !== 'axis-z') return false;
  }
  return true;
}

/** Resolve a JointMateRef to the InstanceEntity, returning null on missing/wrong kind. */
function resolveInstance(ref: JointMateRef, doc: CadDocument): InstanceEntity | null {
  const e = doc.entities[ref.instanceId];
  if (!e || e.kind !== 'instance') return null;
  return e as InstanceEntity;
}

// ---------------------------------------------------------------------------
// Drive relation topo-sort (Kahn's algorithm) for cycle detection
// ---------------------------------------------------------------------------

/**
 * Topological sort of all drive relation ids by dependency (driver → driven).
 * Returns { sorted, cycleSet } where cycleSet contains ids whose drivers form a cycle.
 *
 * @pure
 */
function driveTopoSort(driveRelations: Record<string, DriveRelation>): {
  sorted: string[];
  cycleSet: Set<string>;
} {
  // Build a joint-id graph: who drives whom.
  // We topo-sort JOINT ids (not drive relation ids) to detect cycles.
  // A joint has in-degree = number of drive relations where it is `driven`.
  const jointIds = new Set<string>();
  for (const dr of Object.values(driveRelations)) {
    jointIds.add(dr.driver);
    jointIds.add(dr.driven);
  }

  // inDegree[jointId] = number of drive relations pointing AT it (as driven)
  const inDegree = new Map<string, number>();
  // adjacency: driver → [driven, ...]
  const adj = new Map<string, string[]>();
  for (const jid of jointIds) {
    inDegree.set(jid, 0);
    adj.set(jid, []);
  }
  for (const dr of Object.values(driveRelations)) {
    inDegree.set(dr.driven, (inDegree.get(dr.driven) ?? 0) + 1);
    adj.get(dr.driver)?.push(dr.driven);
  }

  // Kahn
  const queue: string[] = [];
  for (const [jid, deg] of inDegree) {
    if (deg === 0) queue.push(jid);
  }
  const sorted: string[] = [];
  while (queue.length > 0) {
    const jid = queue.shift()!;
    sorted.push(jid);
    for (const neighbor of adj.get(jid) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  const cycleSet = new Set<string>();
  for (const jid of jointIds) {
    if (!sorted.includes(jid)) cycleSet.add(jid);
  }

  return { sorted, cycleSet };
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

  if (dfs(drivenJointId)) {
    return path.join(' → ');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Motion evaluation — shared logic for evaluate_motion and bake_motion
// ---------------------------------------------------------------------------

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
    resolvedJoints[jid] = resolveJointValue(rawValue, doc) ?? rawValue;
  }

  // Step 2: propagate drive relations in topo order
  const { sorted: sortedJoints } = driveTopoSort(doc.driveRelations);
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
    const axisVec = normalizeAxis(joint.axis);

    if (joint.kind === 'revolute') {
      // Revolute: rotate b around axis through a's position by `value` radians.
      const pivot = instanceA.position;
      const bPos: Vec3 = instancePositions[joint.b.instanceId] ?? instanceB.position;
      const bRot: Vec3 = instanceRotations[joint.b.instanceId] ?? instanceB.rotation;

      // Rotate the offset vector (b relative to a) around the axis
      const offset: Vec3 = [bPos[0] - pivot[0], bPos[1] - pivot[1], bPos[2] - pivot[2]];
      const rotatedOffset = rotateAboutAxis(offset, axisVec, value);
      instancePositions[joint.b.instanceId] = [
        pivot[0] + rotatedOffset[0],
        pivot[1] + rotatedOffset[1],
        pivot[2] + rotatedOffset[2],
      ];
      // Accumulate rotation on b by adding angle to the axis component
      // Simple: add angle to Euler component matching axis shorthand
      const deltaRot: Vec3 =
        joint.axis === 'x'
          ? [value, 0, 0]
          : joint.axis === 'y'
            ? [0, value, 0]
            : joint.axis === 'z'
              ? [0, 0, value]
              : [axisVec[0] * value, axisVec[1] * value, axisVec[2] * value];
      instanceRotations[joint.b.instanceId] = [
        bRot[0] + deltaRot[0],
        bRot[1] + deltaRot[1],
        bRot[2] + deltaRot[2],
      ];
    } else {
      // Prismatic: translate b along axis by `value` units from a's position.
      const aPos = instanceA.position;
      instancePositions[joint.b.instanceId] = [
        aPos[0] + axisVec[0] * value,
        aPos[1] + axisVec[1] * value,
        aPos[2] + axisVec[2] * value,
      ];
      // Prismatic does not change rotation
      const bRot = instanceRotations[joint.b.instanceId] ?? instanceB.rotation;
      instanceRotations[joint.b.instanceId] = bRot;
    }
  }

  return { resolvedJoints, instancePositions, instanceRotations };
}
