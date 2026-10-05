import type { Joint, JointMateRef } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { nextId } from '../lib/id';
import { resolveNumeric } from './expression';
import { instanceFrameRef } from './instanceFrameRef';
import { isValidAxis } from './jointsKinematics';
import { noop } from './noop';
/**
 * @command add_joint
 * @pure
 * @layer core/commands
 * @affects appends 1 entry to doc.joints and doc.jointOrder
 * @invariant both a.instanceId and b.instanceId must exist as InstanceEntity in doc.entities
 * @invariant axis must be 'x'|'y'|'z' or a [number,number,number] Vec3
 * @failure unknown instanceId / non-instance entity / invalid axis → no-op, affected:[]
 */
export const addJoint = defineCommand({
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
  params: z.object({
    kind: z
      .enum(['revolute', 'prismatic'])
      .describe(
        'Joint type. "revolute": rotation about an axis (like a hinge or pin). ' +
          '"prismatic": linear translation along an axis (like a slider or piston).',
      ),
    a: instanceFrameRef(
      'first',
      'First instance frame reference (the fixed/anchor frame). ' +
        '{ instanceId: "<id>", frame?: "origin"|"axis-x"|"axis-y"|"axis-z" }. ' +
        'instanceId must be an existing InstanceEntity. frame defaults to "origin".',
    ),
    b: instanceFrameRef(
      'second',
      'Second instance frame reference (the moving frame). ' +
        '{ instanceId: "<id>", frame?: "origin"|"axis-x"|"axis-y"|"axis-z" }. ' +
        'instanceId must be an existing InstanceEntity. frame defaults to "origin".',
    ),
    axis: z
      .union([z.string(), z.array(z.number())])
      .describe(
        'Rotation or slide axis. Use "x", "y", or "z" for world-aligned axes, ' +
          'or pass a [x,y,z] unit vector array for an arbitrary direction.',
      ),
    id: z
      .string()
      .optional()
      .describe(
        'Optional explicit joint id. When omitted a unique id is generated. ' +
          'If the id already exists in doc.joints the command is a no-op.',
      ),
  }),
  run: (doc, { kind, a, b, axis, id }): CommandResult => {
    for (const [side, ref] of [
      ['a', a],
      ['b', b],
    ] as const) {
      if (ref.instanceId.length === 0) {
        return noop(
          doc,
          `add_joint: "${side}" must be an object with a non-empty instanceId string.`,
        );
      }
    }
    if (!isValidAxis(axis)) {
      return noop(
        doc,
        `add_joint: invalid axis '${JSON.stringify(axis)}'. Use "x", "y", "z", or a [x,y,z] number array.`,
      );
    }
    for (const [side, ref] of [
      ['a', a],
      ['b', b],
    ] as const) {
      if (doc.entities[ref.instanceId]?.kind !== 'instance') {
        return noop(
          doc,
          `add_joint: ${side}.instanceId '${ref.instanceId}' does not exist or is not an InstanceEntity.`,
        );
      }
    }

    const jointId = id !== undefined && id.length > 0 ? id : nextId('joint');
    if (jointId in doc.joints) {
      return noop(doc, `add_joint: joint id '${jointId}' already exists — no change made.`);
    }

    const mateRef = ({ instanceId, frame }: typeof a): JointMateRef =>
      frame !== undefined ? { instanceId, frame } : { instanceId };
    const refs = { a: mateRef(a), b: mateRef(b), axis };
    const newJoint: Joint =
      kind === 'revolute'
        ? { id: jointId, kind, ...refs, angle: 0 }
        : { id: jointId, kind, ...refs, displacement: 0 };
    const newDoc = {
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
});

/**
 * @command delete_joint
 * @pure
 * @layer core/commands
 * @affects removes 1 joint from doc.joints and doc.jointOrder; cascade-removes dependent DriveRelations
 * @invariant jointOrder and joints remain consistent after deletion
 * @failure unknown joint id → no-op, affected:[]
 */
export const deleteJoint = defineCommand({
  name: 'delete_joint',
  annotations: { destructive: true },
  description:
    'Remove a kinematic joint from the document by its id. ' +
    'Any DriveRelation whose "driver" or "driven" field references this joint id is also removed (cascade). ' +
    'If the joint id does not exist the document is left unchanged.',
  params: z.object({
    id: z
      .string()
      .describe(
        'Id of the joint to remove. Must match an existing joint id exactly. ' +
          'Use evaluate_motion or describe_scene to list joint ids.',
      ),
  }),
  run: (doc, { id }): CommandResult => {
    if (!(id in doc.joints)) {
      return noop(doc, `delete_joint: joint '${String(id)}' does not exist — no change made.`);
    }

    const joint = doc.joints[id]!;
    const removedDrIds = Object.entries(doc.driveRelations)
      .filter(([, dr]) => dr.driver === id || dr.driven === id)
      .map(([drId]) => drId);
    const without = <T>(record: Record<string, T>, ids: readonly string[]): Record<string, T> =>
      Object.fromEntries(Object.entries(record).filter(([key]) => !ids.includes(key)));

    const newDoc = {
      ...doc,
      joints: without(doc.joints, [id]),
      jointOrder: doc.jointOrder.filter((jid) => jid !== id),
      driveRelations: without(doc.driveRelations, removedDrIds),
      driveRelationOrder: doc.driveRelationOrder.filter((drid) => !removedDrIds.includes(drid)),
    };

    const cascadeSummary =
      removedDrIds.length > 0
        ? ` Also removed ${removedDrIds.length} drive relation(s): ${removedDrIds.join(', ')}.`
        : '';

    return {
      document: newDoc,
      summary: `delete_joint: removed '${joint.kind}' joint '${id}'.${cascadeSummary}`,
      affected: [],
    };
  },
});

/**
 * @command set_joint_value
 * @pure
 * @layer core/commands
 * @affects updates angle (revolute) or displacement (prismatic) on the specified joint
 * @invariant joint must exist in doc.joints
 * @failure unknown joint id → no-op, affected:[]
 */
export const setJointValue = defineCommand({
  name: 'set_joint_value',
  description:
    'Set the current value of a kinematic joint. ' +
    'For revolute joints, "value" is the rotation angle in radians. ' +
    'For prismatic joints, "value" is the displacement in document units. ' +
    '"value" may be a plain number or a parameter expression string (e.g. "=spoke_angle * 2" or "gap / 3"). ' +
    'Expression strings are stored as-is and evaluated when evaluate_motion or bake_motion is called. ' +
    'Call evaluate_motion (query) or bake_motion (mutates doc) to apply the new value to instance transforms.',
  params: z.object({
    id: z.string().describe('Id of the joint to update. Must exist in doc.joints.'),
    value: z
      .union([z.string(), z.number()])
      .describe(
        'New joint value. For revolute: angle in radians. For prismatic: displacement in document units. ' +
          'May be a plain number ("1.5708") or a parameter expression string ("spoke_angle * 2"). ' +
          'Expression strings reference named parameters in doc.parameters.',
      ),
  }),
  run: (doc, { id, value }): CommandResult => {
    if (!(id in doc.joints)) {
      return noop(doc, `set_joint_value: joint '${String(id)}' does not exist — no change made.`);
    }

    const existing = doc.joints[id]!;
    const resolved = resolveNumeric(value, doc.parameters);
    const fieldName = existing.kind === 'revolute' ? 'angle' : 'displacement';
    const current = existing.kind === 'revolute' ? existing.angle : existing.displacement;
    const storedValue = resolved ?? current;
    const newDoc = {
      ...doc,
      joints: { ...doc.joints, [id]: { ...existing, [fieldName]: storedValue } as Joint },
    };

    return {
      document: newDoc,
      summary:
        `set_joint_value: joint '${id}' (${existing.kind}) ${fieldName} set to ${storedValue}` +
        (typeof value === 'string' ? ` (expression: "${value}").` : '.'),
      affected: [id],
    };
  },
});
