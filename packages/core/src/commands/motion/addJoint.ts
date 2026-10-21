import type { Joint, JointMateRef } from '../../model/types';
import { JOINT_DOF } from '../../model/joints';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { idOrNext, idTaken } from '../../lib/explicitId';
import { instanceFrameRef, instanceRefsProblem } from '../assembly/instanceFrameRef';
import { isValidAxis } from '../../lib/axis';
import { changed, noop } from '../noop';
import { camFollower } from './camProfile';
import { unitAxis } from './rigidMotion';

const AXIS_PARAM = z.union([z.string(), z.array(z.number())]);

const KIND_HELP =
  '"revolute": rotation about axis (hinge, 1 DOF: angle rad). "prismatic": slide along axis (1 DOF: displacement). ' +
  '"rigid": b is welded to a (0 DOF). "cylindrical": rotate AND slide along the same axis (2 DOF: [angle, displacement]). ' +
  '"pin_slot": a pin rotating about axis that also slides along slotAxis (2 DOF: [angle, displacement]). ' +
  '"planar": two slides in the plane normal to axis plus a rotation about it (3 DOF: [u, v, angle]; u,v = right-handed basis of the plane, for axis z: x then y). ' +
  '"ball": three rotations about the pivot (3 DOF: Euler XYZ angles). ' +
  '"cam": follower b slides along axis by an amount read from the closed profile entity profileId as joint camJoint (a revolute) turns (0 DOF, derived).';

/**
 * @affects appends 1 entry to doc.joints and doc.jointOrder
 * @invariant both a.instanceId and b.instanceId must exist as InstanceEntity in doc.entities
 * @invariant axis must be 'x'|'y'|'z' or a [number,number,number] Vec3; values/limits have at most one entry per DOF of the kind
 * @invariant cam: camJoint is a revolute joint, profileId a closed polyline/circle/rectangle containing the rotation centre
 * @failure unknown instanceId / non-instance entity / invalid axis / bad DOF arrays / bad cam or pin_slot data → no-op, affected:[]
 */
export const addJoint = defineCommand({
  name: 'add_joint',
  description:
    'Add a kinematic joint between two InstanceEntity frames to model a mechanism (poses only, no forces; for rigid-body physics with masses and forces use add_body_joint + simulate_motion instead). Kinds: ' +
    KIND_HELP +
    ' "a" and "b" are MateRef objects { instanceId, frame? }; b moves relative to a about pivot (default: a\'s origin; give pivot to ' +
    'put the pin elsewhere, e.g. the far end of a link). "axis" is "x"|"y"|"z" or a [x,y,z] vector. ' +
    'Closed loops (four-bar, slider-crank): add every joint, mark the joints whose value should be SOLVED passive:true, drive the others with set_joint_value; ' +
    'evaluate_motion then solves the loop (Levenberg-Marquardt) and refuse when it cannot close. ' +
    '"values" are initial DOF values (default 0; for passive joints the initial guess, which picks the assembly branch); "limits" one {min,max} per DOF. ' +
    'Use set_joint_value to drive the joint; evaluate_motion (apply=true to move the instances) applies it. For gear/belt ratios between kinematic joints use add_drive_relation (add_gear_coupling is the physics equivalent). Returns the new joint id in affected[0].',
  params: z.object({
    kind: z
      .enum(['revolute', 'prismatic', 'rigid', 'cylindrical', 'pin_slot', 'planar', 'ball', 'cam'])
      .describe('Joint type; see the command description.'),
    a: instanceFrameRef(
      'first',
      'First instance frame reference (the fixed/anchor frame). { instanceId: "<id>", frame?: "origin"|"axis-x"|"axis-y"|"axis-z" }. ' +
        'instanceId must be an existing InstanceEntity. frame defaults to "origin".',
    ),
    b: instanceFrameRef(
      'second',
      'Second instance frame reference (the moving frame). { instanceId: "<id>", frame?: "origin"|"axis-x"|"axis-y"|"axis-z" }. ' +
        'instanceId must be an existing InstanceEntity. frame defaults to "origin".',
    ),
    axis: AXIS_PARAM.describe('Rotation / slide axis (planar: plane normal; cam: follower slide axis). "x", "y", "z" or a [x,y,z] vector.'),
    pivot: vec3('Optional world point [x,y,z] (rest pose) the joint acts about. Default: the origin of instance a.').optional(),
    slotAxis: AXIS_PARAM.optional().describe('pin_slot only: direction the pin slides along ("x"|"y"|"z" or [x,y,z]).'),
    values: z
      .array(z.number())
      .optional()
      .describe('Initial DOF values in kind order (radians / document units). Default all 0. Not for rigid and cam.'),
    limits: z
      .array(
        z.object({
          min: z.number().optional().describe('Lower bound (radians or document units). Omit for none.'),
          max: z.number().optional().describe('Upper bound (radians or document units). Omit for none.'),
        }),
      )
      .optional()
      .describe('Travel limit per DOF, same order as values: { min?, max? } in radians / document units. Values are clamped into it.'),
    passive: z
      .boolean()
      .optional()
      .describe('True when the joint value is an unknown of a closed loop: it is solved so the loop closes. Default false.'),
    camJoint: z.string().optional().describe('cam only: id of the revolute joint whose angle drives the follower.'),
    profileId: z
      .string()
      .optional()
      .describe(
        'cam only: id of the 2D profile entity (closed polyline, circle or rectangle) whose local XY origin is the cam rotation centre. ' +
          'Its boundary radius along the follower direction gives the follower lift.',
      ),
    id: z
      .string()
      .optional()
      .describe(
        'Optional explicit joint id. When omitted a unique id is generated. If the id already exists in doc.joints the command is a no-op.',
      ),
  }),
  run: (doc, { kind, a, b, axis, pivot, slotAxis, values, limits, passive, camJoint, profileId, id }): CommandResult => {
    if (!isValidAxis(axis))
      return noop(doc, `add_joint: invalid axis '${JSON.stringify(axis)}'. Use "x", "y", "z", or a [x,y,z] number array.`);
    const refProblem = instanceRefsProblem(doc, 'add_joint', { a, b });
    if (refProblem !== null) return noop(doc, refProblem);
    const dof = JOINT_DOF[kind].length;
    if ((values?.length ?? 0) > dof || (limits?.length ?? 0) > dof)
      return noop(doc, `add_joint: a ${kind} joint has ${dof} DOF; values/limits may have at most ${dof} entries.`);
    if (values !== undefined && values.some((v) => !Number.isFinite(v))) return noop(doc, 'add_joint: values must be finite numbers.');
    if (kind === 'pin_slot' && !isValidAxis(slotAxis)) return noop(doc, 'add_joint: pin_slot needs slotAxis ("x"|"y"|"z" or [x,y,z]).');
    if (kind === 'cam') {
      const driver = camJoint === undefined ? undefined : doc.joints[camJoint];
      if (driver?.kind !== 'revolute' || profileId === undefined)
        return noop(doc, 'add_joint: cam needs camJoint (the id of an existing revolute joint) and profileId (the cam profile entity).');
      const follower = camFollower(doc, profileId, unitAxis(driver.axis), unitAxis(axis));
      if (typeof follower === 'string') return noop(doc, `add_joint: cam ${follower}.`);
    }
    const jointId = idOrNext(id, 'joint');
    if (idTaken(doc.joints, jointId)) return noop(doc, `add_joint: joint id '${jointId}' already exists — no change made.`);
    const mateRef = ({ instanceId, frame }: typeof a): JointMateRef => (frame !== undefined ? { instanceId, frame } : { instanceId });
    const initial = Array.from({ length: dof }, (_, i) => values?.[i] ?? 0);
    const common = {
      a: mateRef(a),
      b: mateRef(b),
      axis,
      ...(pivot !== undefined ? { pivot } : {}),
      ...(passive === true ? { passive } : {}),
      ...(limits !== undefined ? { limits } : {}),
    };
    const newJoint = ((): Joint => {
      const head = { id: jointId };
      if (kind === 'revolute') return { ...head, kind, ...common, angle: initial[0] ?? 0 };
      if (kind === 'prismatic') return { ...head, kind, ...common, displacement: initial[0] ?? 0 };
      if (kind === 'pin_slot') return { ...head, kind, ...common, values: initial, slotAxis: isValidAxis(slotAxis) ? slotAxis : 'x' };
      if (kind === 'cam') return { ...head, kind, ...common, values: [], camJoint: camJoint ?? '', profileId: profileId ?? '' };
      if (kind === 'cylindrical') return { ...head, kind, ...common, values: initial };
      if (kind === 'planar') return { ...head, kind, ...common, values: initial };
      if (kind === 'ball') return { ...head, kind, ...common, values: initial };
      return { ...head, kind, ...common, values: [] };
    })();
    const newDoc = { ...doc, joints: { ...doc.joints, [jointId]: newJoint }, jointOrder: [...doc.jointOrder, jointId] };
    return changed(
      newDoc,
      `add_joint: added '${kind}' joint '${jointId}' (${dof} DOF${passive === true ? ', passive' : ''}) between instance '${a.instanceId}' (a) ` +
        `and instance '${b.instanceId}' (b), axis=${JSON.stringify(axis)}.`,
      [jointId],
    );
  },
});
