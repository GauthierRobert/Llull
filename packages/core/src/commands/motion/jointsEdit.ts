import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { resolveNumeric } from '../parametric/expression';
import { clampToLimit, withJointValue } from './jointValues';
import { JOINT_DOF } from '../../model/joints';
import { changed, noop, report } from '../noop';
/**
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
        'Id of the joint to remove. Must match an existing joint id exactly. ' + 'Use evaluate_motion or describe_scene to list joint ids.',
      ),
  }),
  run: (doc, { id }): CommandResult => {
    const joint = Object.hasOwn(doc.joints, id) ? doc.joints[id] : undefined;
    if (!joint) return noop(doc, `delete_joint: joint '${String(id)}' does not exist — no change made.`);
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
      removedDrIds.length > 0 ? ` Also removed ${removedDrIds.length} drive relation(s): ${removedDrIds.join(', ')}.` : '';
    return report(newDoc, `delete_joint: removed '${joint.kind}' joint '${id}'.${cascadeSummary}`);
  },
});

/**
 * @affects updates one DOF value of the specified joint (clamped into its limit)
 * @failure unknown joint id, DOF index out of range, rigid / cam joint (no settable DOF), non-numeric value -> no-op, affected:[]
 * @invariant joint must exist in doc.joints
 */
export const setJointValue = defineCommand({
  name: 'set_joint_value',
  description:
    'Set the current value of a kinematic joint. For revolute joints, "value" is the rotation angle in radians. ' +
    'For prismatic joints, "value" is the displacement in document units. Multi-DOF joints (cylindrical, pin_slot, planar, ball) ' +
    'take "dof" = index of the coordinate (0-based, order: cylindrical/pin_slot [angle, slide]; planar [u, v, angle]; ball [rx, ry, rz]). ' +
    'rigid and cam joints have no settable value (a cam follows its camJoint). The value is clamped into the joint limit when one is set. ' +
    '"value" may be a plain number or a parameter expression string (e.g. "=spoke_angle * 2" or "gap / 3"). ' +
    'Expression strings are stored as-is and evaluated when evaluate_motion is called. ' +
    'Call evaluate_motion (query; apply=true mutates the doc) to apply the new value to instance transforms.',
  params: z.object({
    id: z.string().describe('Id of the joint to update. Must exist in doc.joints.'),
    value: z
      .union([z.string(), z.number()])
      .describe(
        'New joint value. For revolute: angle in radians. For prismatic: displacement in document units. ' +
          'May be a plain number ("1.5708") or a parameter expression string ("spoke_angle * 2"). ' +
          'Expression strings reference named parameters in doc.parameters.',
      ),
    dof: z.number().int().min(0).optional().describe('Index of the coordinate to set on a multi-DOF joint (0-based). Default 0.'),
  }),
  run: (doc, { id, value, dof = 0 }): CommandResult => {
    const existing = Object.hasOwn(doc.joints, id) ? doc.joints[id] : undefined;
    if (!existing) return noop(doc, `set_joint_value: joint '${String(id)}' does not exist — no change made.`);
    const count = JOINT_DOF[existing.kind].length;
    if (existing.kind === 'cam' || dof >= count)
      return noop(doc, `set_joint_value: a ${existing.kind} joint has no settable coordinate ${dof} (${count} DOF) — no change made.`);
    const resolved = resolveNumeric(value, doc.parameters);
    if (resolved === null || !Number.isFinite(resolved))
      return noop(doc, `set_joint_value: '${String(value)}' is not a number or a valid expression — no change made.`);
    const limited = clampToLimit(resolved, existing.limits?.[dof]);
    const newDoc = { ...doc, joints: { ...doc.joints, [id]: withJointValue(existing, dof, limited.value) } };
    return changed(
      newDoc,
      `set_joint_value: joint '${id}' (${existing.kind}) coordinate ${dof} set to ${limited.value}` +
        (limited.clamped ? ` (clamped from ${resolved} to its limit)` : '') +
        (typeof value === 'string' ? ` (expression: "${value}").` : '.'),
      [id],
    );
  },
});
