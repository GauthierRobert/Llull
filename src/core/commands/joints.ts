/**
 * @command add_joint
 * @command delete_joint
 * @command set_joint_value
 * @command add_drive_relation
 * @command delete_drive_relation
 * @command evaluate_motion
 * @command bake_motion
 * @pure
 * @layer core/commands
 * @affects add_joint: appends to doc.joints and doc.jointOrder
 *          delete_joint: removes from doc.joints/doc.jointOrder; cascade-removes dependent DriveRelations
 *          set_joint_value: updates angle or displacement on an existing joint
 *          add_drive_relation: appends to doc.driveRelations and doc.driveRelationOrder
 *          delete_drive_relation: removes from doc.driveRelations/doc.driveRelationOrder
 *          evaluate_motion: no-op (query) — returns resolved joint values + instance transforms in data
 *          bake_motion: updates instance positions/rotations based on evaluated joint values
 * @invariant Joint ids are unique; JointMateRef.instanceId must be an InstanceEntity in doc.entities
 * @invariant DriveRelation graph is acyclic (Kahn topo-sort enforced on add_drive_relation)
 * @failure unknown joint id / unknown instanceId → no-op, affected:[]
 *          self-coupling / cycle in drive graph → no-op, affected:[]
 *          evaluate_motion with no joints → empty data, friendly summary
 */

import type {
  CadDocument,
  InstanceEntity,
  Joint,
  JointKind,
  JointMateRef,
  DriveRelation,
  Vec3,
} from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { nextId } from '../../lib/id';
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
function resolveJointValue(raw: number | string, doc: CadDocument): number | null {
  if (typeof raw === 'number') return raw;
  const env: Record<string, number> = {};
  for (const [name, param] of Object.entries(doc.parameters)) {
    env[name] = param.value;
  }
  const result = evaluateExpression(raw, env);
  return result.ok ? result.value : null;
}

/** Validate that a string is a valid named axis shorthand or that the value is a Vec3. */
function isValidAxis(v: unknown): v is 'x' | 'y' | 'z' | Vec3 {
  if (v === 'x' || v === 'y' || v === 'z') return true;
  if (!Array.isArray(v) || v.length !== 3) return false;
  return (v as unknown[]).every((c) => typeof c === 'number' && Number.isFinite(c));
}

/** Validate a JointMateRef shape. */
function isValidMateRef(v: unknown): v is { instanceId: string; frame?: string } {
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
function detectCycleOnAdd(
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
 * 1. Collect base joint values (resolving expression strings via doc.parameters).
 * 2. Topo-sort drive relations and propagate: driven = driver * ratio + offset.
 * 3. Apply each joint to instance b's position/rotation relative to instance a.
 *
 * Returns EvaluatedMotion. Never mutates doc.
 *
 * @pure
 */
function evaluateMotionInternal(doc: CadDocument): EvaluatedMotion {
  // Step 1: collect base joint values
  const resolvedJoints: Record<string, number> = {};
  for (const [jid, joint] of Object.entries(doc.joints)) {
    const rawValue = joint.kind === 'revolute' ? joint.angle : joint.displacement;
    const resolved = resolveJointValue(rawValue, doc);
    resolvedJoints[jid] = resolved ?? rawValue;
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
    if (driverValue === undefined) continue;
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
        joint.axis === 'x' ? [value, 0, 0] :
        joint.axis === 'y' ? [0, value, 0] :
        joint.axis === 'z' ? [0, 0, value] :
        [
          axisVec[0] * value,
          axisVec[1] * value,
          axisVec[2] * value,
        ];
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

// ---------------------------------------------------------------------------
// add_joint
// ---------------------------------------------------------------------------

const VALID_JOINT_KINDS: ReadonlySet<string> = new Set<JointKind>(['revolute', 'prismatic']);

interface AddJointParams {
  kind: string;
  a: { instanceId: string; frame?: string };
  b: { instanceId: string; frame?: string };
  axis: string | [number, number, number];
  id?: string;
}

/**
 * @command add_joint
 * @pure
 * @layer core/commands
 * @affects appends 1 entry to doc.joints and doc.jointOrder
 * @invariant both a.instanceId and b.instanceId must exist as InstanceEntity in doc.entities
 * @invariant axis must be 'x'|'y'|'z' or a [number,number,number] Vec3
 * @failure unknown instanceId / non-instance entity / invalid axis → no-op, affected:[]
 */
export const addJoint: CommandDefinition<AddJointParams> = {
  name: 'add_joint',
  description:
    'Add a kinematic joint between two InstanceEntity frames to model a mechanism. ' +
    'A "revolute" joint allows rotation of instance b around the given axis through instance a\'s origin. ' +
    'A "prismatic" joint allows translation of instance b along the given axis from instance a\'s origin. ' +
    '"a" and "b" are MateRef objects: { instanceId: "<id>", frame?: "origin"|"axis-x"|"axis-y"|"axis-z" }. ' +
    '"axis" is the rotation/slide axis: use "x", "y", or "z" for world axes, or a [x,y,z] unit vector. ' +
    'Initial joint value (angle / displacement) defaults to 0. ' +
    'Use set_joint_value to drive the joint. Use evaluate_motion or bake_motion to apply motion to instances. ' +
    'Returns the new joint id in affected[0].',
  paramsSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        description:
          'Joint type. "revolute": rotation about an axis (like a hinge or pin). ' +
          '"prismatic": linear translation along an axis (like a slider or piston).',
        enum: ['revolute', 'prismatic'],
      },
      a: {
        type: 'object',
        description:
          'First instance frame reference (the fixed/anchor frame). ' +
          '{ instanceId: "<id>", frame?: "origin"|"axis-x"|"axis-y"|"axis-z" }. ' +
          'instanceId must be an existing InstanceEntity. frame defaults to "origin".',
        properties: {
          instanceId: { type: 'string', description: 'Id of the first InstanceEntity.' },
          frame: {
            type: 'string',
            description: 'Frame selector: origin (default), axis-x, axis-y, or axis-z.',
            enum: ['origin', 'axis-x', 'axis-y', 'axis-z'],
          },
        },
      },
      b: {
        type: 'object',
        description:
          'Second instance frame reference (the moving frame). ' +
          '{ instanceId: "<id>", frame?: "origin"|"axis-x"|"axis-y"|"axis-z" }. ' +
          'instanceId must be an existing InstanceEntity. frame defaults to "origin".',
        properties: {
          instanceId: { type: 'string', description: 'Id of the second InstanceEntity.' },
          frame: {
            type: 'string',
            description: 'Frame selector: origin (default), axis-x, axis-y, or axis-z.',
            enum: ['origin', 'axis-x', 'axis-y', 'axis-z'],
          },
        },
      },
      axis: {
        type: 'string',
        description:
          'Rotation or slide axis. Use "x", "y", or "z" for world-aligned axes, ' +
          'or pass a [x,y,z] unit vector array for an arbitrary direction.',
      },
      id: {
        type: 'string',
        description:
          'Optional explicit joint id. When omitted a unique id is generated. ' +
          'If the id already exists in doc.joints the command is a no-op.',
      },
    },
    required: ['kind', 'a', 'b', 'axis'],
  },
  run: (doc, { kind, a, b, axis, id }): CommandResult => {
    if (!VALID_JOINT_KINDS.has(kind)) {
      return {
        document: doc,
        summary: `add_joint: unknown kind '${String(kind)}'. Allowed: revolute, prismatic.`,
        affected: [],
      };
    }

    if (!isValidMateRef(a)) {
      return {
        document: doc,
        summary: 'add_joint: "a" must be an object with a non-empty instanceId string.',
        affected: [],
      };
    }
    if (!isValidMateRef(b)) {
      return {
        document: doc,
        summary: 'add_joint: "b" must be an object with a non-empty instanceId string.',
        affected: [],
      };
    }

    if (!isValidAxis(axis)) {
      return {
        document: doc,
        summary:
          `add_joint: invalid axis '${JSON.stringify(axis)}'. Use "x", "y", "z", or a [x,y,z] number array.`,
        affected: [],
      };
    }

    const entityA = doc.entities[a.instanceId];
    if (!entityA || entityA.kind !== 'instance') {
      return {
        document: doc,
        summary: `add_joint: a.instanceId '${a.instanceId}' does not exist or is not an InstanceEntity.`,
        affected: [],
      };
    }
    const entityB = doc.entities[b.instanceId];
    if (!entityB || entityB.kind !== 'instance') {
      return {
        document: doc,
        summary: `add_joint: b.instanceId '${b.instanceId}' does not exist or is not an InstanceEntity.`,
        affected: [],
      };
    }

    const jointId = typeof id === 'string' && id.length > 0 ? id : nextId('joint');
    if (jointId in doc.joints) {
      return {
        document: doc,
        summary: `add_joint: joint id '${jointId}' already exists — no change made.`,
        affected: [],
      };
    }

    type FrameValue = 'origin' | 'axis-x' | 'axis-y' | 'axis-z';
    const mateRefA: JointMateRef =
      a.frame !== undefined
        ? { instanceId: a.instanceId, frame: a.frame as FrameValue }
        : { instanceId: a.instanceId };
    const mateRefB: JointMateRef =
      b.frame !== undefined
        ? { instanceId: b.instanceId, frame: b.frame as FrameValue }
        : { instanceId: b.instanceId };

    const newJoint: Joint =
      kind === 'revolute'
        ? { id: jointId, kind: 'revolute', a: mateRefA, b: mateRefB, axis: axis as 'x' | 'y' | 'z' | Vec3, angle: 0 }
        : { id: jointId, kind: 'prismatic', a: mateRefA, b: mateRefB, axis: axis as 'x' | 'y' | 'z' | Vec3, displacement: 0 };

    const newDoc: CadDocument = {
      ...doc,
      joints: { ...doc.joints, [jointId]: newJoint },
      jointOrder: [...doc.jointOrder, jointId],
    };

    return {
      document: newDoc,
      summary:
        `add_joint: added '${kind}' joint '${jointId}' between instance '${a.instanceId}' (a) ` +
        `and instance '${b.instanceId}' (b), axis=${JSON.stringify(axis)}.`,
      affected: [jointId],
    };
  },
};

// ---------------------------------------------------------------------------
// delete_joint
// ---------------------------------------------------------------------------

interface DeleteJointParams {
  id: string;
}

/**
 * @command delete_joint
 * @pure
 * @layer core/commands
 * @affects removes 1 joint from doc.joints and doc.jointOrder; cascade-removes dependent DriveRelations
 * @invariant jointOrder and joints remain consistent after deletion
 * @failure unknown joint id → no-op, affected:[]
 */
export const deleteJoint: CommandDefinition<DeleteJointParams> = {
  name: 'delete_joint',
  annotations: { destructive: true },
  description:
    'Remove a kinematic joint from the document by its id. ' +
    'Any DriveRelation whose "driver" or "driven" field references this joint id is also removed (cascade). ' +
    'If the joint id does not exist the document is left unchanged.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Id of the joint to remove. Must match an existing joint id exactly. ' +
          'Use evaluate_motion or describe_scene to list joint ids.',
      },
    },
    required: ['id'],
  },
  run: (doc, { id }): CommandResult => {
    if (typeof id !== 'string' || !(id in doc.joints)) {
      return {
        document: doc,
        summary: `delete_joint: joint '${String(id)}' does not exist — no change made.`,
        affected: [],
      };
    }

    const joint = doc.joints[id]!;

    // Cascade: collect drive relations that reference this joint
    const removedDrIds: string[] = [];
    const newDriveRelations: Record<string, DriveRelation> = {};
    for (const [drId, dr] of Object.entries(doc.driveRelations)) {
      if (dr.driver === id || dr.driven === id) {
        removedDrIds.push(drId);
      } else {
        newDriveRelations[drId] = dr;
      }
    }

    const newJoints = { ...doc.joints };
    delete newJoints[id];

    const newDoc: CadDocument = {
      ...doc,
      joints: newJoints,
      jointOrder: doc.jointOrder.filter((jid) => jid !== id),
      driveRelations: newDriveRelations,
      driveRelationOrder: doc.driveRelationOrder.filter((drid) => !removedDrIds.includes(drid)),
    };

    const cascadeSummary =
      removedDrIds.length > 0 ? ` Also removed ${removedDrIds.length} drive relation(s): ${removedDrIds.join(', ')}.` : '';

    return {
      document: newDoc,
      summary: `delete_joint: removed '${joint.kind}' joint '${id}'.${cascadeSummary}`,
      affected: [],
    };
  },
};

// ---------------------------------------------------------------------------
// set_joint_value
// ---------------------------------------------------------------------------

interface SetJointValueParams {
  id: string;
  value: number | string;
}

/**
 * @command set_joint_value
 * @pure
 * @layer core/commands
 * @affects updates angle (revolute) or displacement (prismatic) on the specified joint
 * @invariant joint must exist in doc.joints
 * @failure unknown joint id → no-op, affected:[]
 */
export const setJointValue: CommandDefinition<SetJointValueParams> = {
  name: 'set_joint_value',
  description:
    'Set the current value of a kinematic joint. ' +
    'For revolute joints, "value" is the rotation angle in radians. ' +
    'For prismatic joints, "value" is the displacement in document units. ' +
    '"value" may be a plain number or a parameter expression string (e.g. "=spoke_angle * 2" or "gap / 3"). ' +
    'Expression strings are stored as-is and evaluated when evaluate_motion or bake_motion is called. ' +
    'Call evaluate_motion (query) or bake_motion (mutates doc) to apply the new value to instance transforms.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Id of the joint to update. Must exist in doc.joints.',
      },
      value: {
        type: 'string',
        description:
          'New joint value. For revolute: angle in radians. For prismatic: displacement in document units. ' +
          'May be a plain number ("1.5708") or a parameter expression string ("spoke_angle * 2"). ' +
          'Expression strings reference named parameters in doc.parameters.',
      },
    },
    required: ['id', 'value'],
  },
  run: (doc, { id, value }): CommandResult => {
    if (typeof id !== 'string' || !(id in doc.joints)) {
      return {
        document: doc,
        summary: `set_joint_value: joint '${String(id)}' does not exist — no change made.`,
        affected: [],
      };
    }

    if (typeof value !== 'number' && typeof value !== 'string') {
      return {
        document: doc,
        summary: `set_joint_value: value must be a number or expression string, got ${typeof value}.`,
        affected: [],
      };
    }

    const existing = doc.joints[id]!;
    let updatedJoint: Joint;

    if (existing.kind === 'revolute') {
      const resolved = resolveJointValue(value, doc);
      updatedJoint = { ...existing, angle: typeof resolved === 'number' ? resolved : existing.angle };
      // Store expression if it's a string (for round-trip); the numeric field stores the last resolved value.
      if (typeof value === 'string') {
        updatedJoint = { ...updatedJoint, angle: resolved ?? existing.angle };
      }
    } else {
      const resolved = resolveJointValue(value, doc);
      updatedJoint = { ...existing, displacement: typeof resolved === 'number' ? resolved : existing.displacement };
      if (typeof value === 'string') {
        updatedJoint = { ...updatedJoint, displacement: resolved ?? existing.displacement };
      }
    }

    const newDoc: CadDocument = {
      ...doc,
      joints: { ...doc.joints, [id]: updatedJoint },
    };

    const fieldName = existing.kind === 'revolute' ? 'angle' : 'displacement';
    const storedValue = existing.kind === 'revolute'
      ? (updatedJoint as typeof existing).angle
      : (updatedJoint as Extract<Joint, { kind: 'prismatic' }>).displacement;

    return {
      document: newDoc,
      summary:
        `set_joint_value: joint '${id}' (${existing.kind}) ${fieldName} set to ${storedValue}` +
        (typeof value === 'string' ? ` (expression: "${value}").` : '.'),
      affected: [id],
    };
  },
};

// ---------------------------------------------------------------------------
// add_drive_relation
// ---------------------------------------------------------------------------

interface AddDriveRelationParams {
  driver: string;
  driven: string;
  ratio: number;
  offset?: number;
  id?: string;
}

/**
 * @command add_drive_relation
 * @pure
 * @layer core/commands
 * @affects appends 1 entry to doc.driveRelations and doc.driveRelationOrder
 * @invariant driver and driven must exist in doc.joints
 * @invariant driver !== driven (no self-coupling)
 * @invariant the resulting drive graph must be acyclic
 * @failure unknown joint id / self-coupling / cycle → no-op, affected:[]
 */
export const addDriveRelation: CommandDefinition<AddDriveRelationParams> = {
  name: 'add_drive_relation',
  description:
    'Couple two kinematic joints: driven_value = driver_value * ratio + offset. ' +
    'Models gear trains (ratio = gear_ratio), belt drives, cam followers, or any linear coupling. ' +
    'Example: two meshing gears with 2:1 ratio — set ratio=2. ' +
    '"driver" is the source joint id (its value propagates). ' +
    '"driven" is the target joint id (its value is computed from the driver). ' +
    '"ratio" is the multiplication factor (may be negative for direction reversal). ' +
    '"offset" is an optional additive phase or position offset (default 0). ' +
    'Cyclic couplings (A→B→A) are rejected with an explanatory summary. ' +
    'Returns the new drive relation id in affected[0].',
  paramsSchema: {
    type: 'object',
    properties: {
      driver: {
        type: 'string',
        description: 'Id of the driving joint (source of motion). Must exist in doc.joints.',
      },
      driven: {
        type: 'string',
        description: 'Id of the driven joint (receives motion). Must exist in doc.joints.',
      },
      ratio: {
        type: 'number',
        description:
          'Coupling ratio: driven = driver * ratio + offset. ' +
          'Use 1.0 for a direct coupling, 2.0 for a 2:1 gear-up, -1.0 to reverse direction.',
      },
      offset: {
        type: 'number',
        description: 'Optional additive offset applied after ratio multiplication. Default: 0.',
      },
      id: {
        type: 'string',
        description:
          'Optional explicit drive relation id. When omitted a unique id is generated. ' +
          'If the id already exists in doc.driveRelations the command is a no-op.',
      },
    },
    required: ['driver', 'driven', 'ratio'],
  },
  run: (doc, { driver, driven, ratio, offset, id }): CommandResult => {
    if (typeof driver !== 'string' || !(driver in doc.joints)) {
      return {
        document: doc,
        summary: `add_drive_relation: driver joint '${String(driver)}' does not exist in doc.joints.`,
        affected: [],
      };
    }
    if (typeof driven !== 'string' || !(driven in doc.joints)) {
      return {
        document: doc,
        summary: `add_drive_relation: driven joint '${String(driven)}' does not exist in doc.joints.`,
        affected: [],
      };
    }
    if (driver === driven) {
      return {
        document: doc,
        summary: `add_drive_relation: driver and driven cannot be the same joint ('${driver}').`,
        affected: [],
      };
    }
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
      return {
        document: doc,
        summary: `add_drive_relation: ratio must be a finite number, got ${String(ratio)}.`,
        affected: [],
      };
    }

    // Cycle detection
    const cyclePath = detectCycleOnAdd(doc.driveRelations, driver, driven);
    if (cyclePath !== null) {
      return {
        document: doc,
        summary: `add_drive_relation: adding this relation would create a cycle: ${cyclePath}. No change made.`,
        affected: [],
      };
    }

    const drId = typeof id === 'string' && id.length > 0 ? id : nextId('dr');
    if (drId in doc.driveRelations) {
      return {
        document: doc,
        summary: `add_drive_relation: drive relation id '${drId}' already exists — no change made.`,
        affected: [],
      };
    }

    const newDr: DriveRelation = {
      id: drId,
      driver,
      driven,
      ratio,
      ...(offset !== undefined ? { offset } : {}),
    };

    const newDoc: CadDocument = {
      ...doc,
      driveRelations: { ...doc.driveRelations, [drId]: newDr },
      driveRelationOrder: [...doc.driveRelationOrder, drId],
    };

    return {
      document: newDoc,
      summary:
        `add_drive_relation: coupled '${driver}' → '${driven}' with ratio=${ratio}` +
        (offset !== undefined ? ` offset=${offset}` : '') +
        ` (id: '${drId}').`,
      affected: [drId],
    };
  },
};

// ---------------------------------------------------------------------------
// delete_drive_relation
// ---------------------------------------------------------------------------

interface DeleteDriveRelationParams {
  id: string;
}

/**
 * @command delete_drive_relation
 * @pure
 * @layer core/commands
 * @affects removes 1 entry from doc.driveRelations and doc.driveRelationOrder
 * @invariant driveRelationOrder and driveRelations remain consistent after deletion
 * @failure unknown drive relation id → no-op, affected:[]
 */
export const deleteDriveRelation: CommandDefinition<DeleteDriveRelationParams> = {
  name: 'delete_drive_relation',
  annotations: { destructive: true },
  description:
    'Remove a drive relation (joint coupling) from the document by its id. ' +
    'The joints themselves are not affected; only the coupling is removed. ' +
    'If the drive relation id does not exist the document is left unchanged.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Id of the drive relation to remove. Must match an existing entry in doc.driveRelations.',
      },
    },
    required: ['id'],
  },
  run: (doc, { id }): CommandResult => {
    if (typeof id !== 'string' || !(id in doc.driveRelations)) {
      return {
        document: doc,
        summary: `delete_drive_relation: drive relation '${String(id)}' does not exist — no change made.`,
        affected: [],
      };
    }

    const dr = doc.driveRelations[id]!;
    const newDriveRelations = { ...doc.driveRelations };
    delete newDriveRelations[id];

    const newDoc: CadDocument = {
      ...doc,
      driveRelations: newDriveRelations,
      driveRelationOrder: doc.driveRelationOrder.filter((drid) => drid !== id),
    };

    return {
      document: newDoc,
      summary: `delete_drive_relation: removed coupling '${dr.driver}' → '${dr.driven}' (id: '${id}').`,
      affected: [],
    };
  },
};

// ---------------------------------------------------------------------------
// evaluate_motion (read-only query)
// ---------------------------------------------------------------------------

/**
 * @command evaluate_motion
 * @pure
 * @layer core/commands
 * @affects nothing — read-only query, affected:[]
 * @invariant document is returned unchanged; resolved joint values propagated in topo order
 * @failure no joints → empty data, friendly summary; unknown instanceIds → those joints skipped
 */
export const evaluateMotion: CommandDefinition<Record<string, never>> = {
  name: 'evaluate_motion',
  annotations: { readOnly: true, metaHistory: true },
  description:
    'Compute the result of applying all kinematic joints and drive relations without mutating the document. ' +
    'Drive relations are walked in topological order: driven_value = driver_value * ratio + offset. ' +
    'Then each joint is applied: revolute rotates instance b around instance a\'s origin along the axis; ' +
    'prismatic translates instance b along the axis from instance a\'s origin. ' +
    'Returns the document unchanged with affected:[] and data: ' +
    '{ resolvedJoints: Record<jointId, number>, ' +
    '  instancePositions: Record<instanceId, Vec3>, ' +
    '  instanceRotations: Record<instanceId, Vec3> }. ' +
    'Call bake_motion to permanently apply these transforms to the document.',
  paramsSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  run: (doc, _params): CommandResult => {
    if (Object.keys(doc.joints).length === 0) {
      return {
        document: doc,
        summary: 'evaluate_motion: no joints defined. Nothing to evaluate.',
        affected: [],
        data: { resolvedJoints: {}, instancePositions: {}, instanceRotations: {} },
      };
    }

    const { resolvedJoints, instancePositions, instanceRotations } = evaluateMotionInternal(doc);

    const jointCount = Object.keys(resolvedJoints).length;
    const movedCount = Object.keys(instancePositions).length;

    return {
      document: doc,
      summary:
        `evaluate_motion: evaluated ${jointCount} joint(s), ${movedCount} instance(s) would move.`,
      affected: [],
      data: { resolvedJoints, instancePositions, instanceRotations },
    };
  },
};

// ---------------------------------------------------------------------------
// bake_motion
// ---------------------------------------------------------------------------

/**
 * @command bake_motion
 * @pure
 * @layer core/commands
 * @affects updates position and rotation of instance entities in doc.entities
 * @invariant joint values and drive relations are unchanged; only instance transforms change
 * @failure no joints → no-op with friendly summary
 */
export const bakeMotion: CommandDefinition<Record<string, never>> = {
  name: 'bake_motion',
  description:
    'Apply all kinematic joints and drive relations to the document, permanently updating ' +
    'the position and rotation of affected InstanceEntity objects. ' +
    'This runs the same calculation as evaluate_motion but WRITES the results into the document. ' +
    'Drive relations are walked in topological order; each joint is then applied to instance b. ' +
    'Revolute joint: rotates instance b around instance a\'s origin along the axis by the joint angle. ' +
    'Prismatic joint: translates instance b along the axis from instance a\'s origin by the displacement. ' +
    'Returns the updated document with affected[] listing all modified instance ids.',
  paramsSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  run: (doc, _params): CommandResult => {
    if (Object.keys(doc.joints).length === 0) {
      return {
        document: doc,
        summary: 'bake_motion: no joints defined. Nothing to bake.',
        affected: [],
      };
    }

    const { resolvedJoints, instancePositions, instanceRotations } = evaluateMotionInternal(doc);

    const movedIds = Object.keys(instancePositions);
    if (movedIds.length === 0) {
      return {
        document: doc,
        summary: 'bake_motion: joints exist but no instance positions changed (all instanceIds may be missing).',
        affected: [],
      };
    }

    // Apply computed positions and rotations to entities
    const newEntities = { ...doc.entities };
    for (const instanceId of movedIds) {
      const existing = newEntities[instanceId];
      if (!existing) continue;
      newEntities[instanceId] = {
        ...existing,
        position: instancePositions[instanceId]!,
        rotation: instanceRotations[instanceId] ?? existing.rotation,
      };
    }

    const jointCount = Object.keys(resolvedJoints).length;

    const newDoc: CadDocument = {
      ...doc,
      entities: newEntities,
    };

    return {
      document: newDoc,
      summary:
        `bake_motion: applied ${jointCount} joint(s); updated position/rotation of ${movedIds.length} instance(s): ${movedIds.join(', ')}.`,
      affected: movedIds,
    };
  },
};
