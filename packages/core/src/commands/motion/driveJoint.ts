import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed, noop } from '../noop';
import { resolveNumeric } from '../parametric/expression';
import { JOINT_DOF } from '../../model/joints';
import { findContactStop } from './contactStop';
import { clampToLimit, jointValues, withJointValue } from './jointValues';

/**
 * @affects sets one DOF value of the joint to the reached value (limit-clamped; stopped early at the first contact of the contact set)
 * @invariant the stored value is on the free side of the contact, within `tolerance` of it
 * @failure unknown joint / contact set, bad dof, cam or rigid joint, non-numeric target -> no-op, affected:[]
 */
export const driveJointTo = defineCommand({
  name: 'drive_joint_to',
  description:
    'Drive a joint from its current value to a target value and store the value reached. With contactSetId the motion STOPS at the first ' +
    'contact of any pair in that contact set (create_contact_set), located by bisection to "tolerance"; closed loops with passive joints also stop ' +
    'where the loop can no longer close. The result data is { requested, reached, stopped, reason?, pair?, from }. ' +
    'Instance placements are not changed: run bake_motion or evaluate_motion afterwards.',
  params: z.object({
    jointId: z.string().describe('Id of the joint to drive (doc.joints).'),
    target: z.union([z.number(), z.string()]).describe('Target value (radians / document units) or a parameter expression.'),
    dof: z.number().int().min(0).optional().describe('Coordinate index for multi-DOF joints. Default 0.'),
    contactSetId: z
      .string()
      .optional()
      .describe('Contact set whose first contact stops the motion. Omit to drive freely (limits still clamp).'),
    tolerance: z.number().positive().optional().describe('Bisection tolerance on the joint value, in joint units. Default 1e-6.'),
    samples: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe('Coarse samples scanned for the first contact before bisecting. Default 200.'),
  }),
  run: (doc, { jointId, target, dof = 0, contactSetId, tolerance = 1e-6, samples = 200 }): CommandResult => {
    const joint = Object.hasOwn(doc.joints, jointId) ? doc.joints[jointId] : undefined;
    if (!joint) return noop(doc, `drive_joint_to: joint '${jointId}' does not exist.`);
    if (joint.kind === 'cam' || dof >= JOINT_DOF[joint.kind].length)
      return noop(doc, `drive_joint_to: a ${joint.kind} joint has no drivable coordinate ${dof}.`);
    const requested = resolveNumeric(target, doc.parameters);
    if (requested === null || !Number.isFinite(requested))
      return noop(doc, `drive_joint_to: '${String(target)}' is not a number or a valid expression.`);
    const contactSet = contactSetId === undefined ? undefined : doc.contactSets?.[contactSetId];
    if (contactSetId !== undefined && contactSet === undefined)
      return noop(doc, `drive_joint_to: contact set '${contactSetId}' does not exist.`);
    const from = jointValues(joint)[dof] ?? 0;
    const goal = clampToLimit(requested, joint.limits?.[dof]).value;
    const stop =
      dof === 0 && (contactSet !== undefined || Object.values(doc.joints).some((other) => other.passive === true))
        ? findContactStop(doc, { mode: 'joint', target: jointId, from, to: goal }, contactSet?.pairs ?? [], samples, tolerance)
        : { stopped: false as const, stopValue: goal };
    const reached = stop.stopped ? stop.stopValue : goal;
    const data = { requested, reached, from, stopped: stop.stopped, ...('reason' in stop ? { reason: stop.reason, pair: stop.pair } : {}) };
    const newDoc = { ...doc, joints: { ...doc.joints, [jointId]: withJointValue(joint, dof, reached) } };
    const summary =
      `drive_joint_to: joint '${jointId}' ${from} -> ${reached}` +
      (stop.stopped
        ? ` (stopped before ${requested}: ${stop.reason === 'loop_open' ? 'the loop cannot close further' : `contact ${stop.pair?.join(' / ')}`})`
        : goal !== requested
          ? ` (target ${requested} clamped to its limit)`
          : '');
    return { ...changed(newDoc, summary, [jointId]), data };
  },
});
