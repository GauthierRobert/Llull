import type { DynamicJoint } from '../../model/dynamics';
import { JOINT_DOF, type JointKind } from '../../model/joints';

export type BodyJointKind = DynamicJoint['kind'];

/** Kinds `add_body_joint` accepts: the dynamics joints plus the kinematic (`add_joint`) names. */
export const BODY_JOINT_KINDS = [
  'revolute',
  'prismatic',
  'spherical',
  'ball',
  'rigid',
  'cylindrical',
  'pin_slot',
  'planar',
  'cam',
] as const;

/** Dynamics joint (MuJoCo hinge / slide / ball) for a kinematic kind, or why none exists. */
export function bodyJointKind(kind: (typeof BODY_JOINT_KINDS)[number]): BodyJointKind | { refusal: string } {
  if (kind === 'revolute' || kind === 'prismatic' || kind === 'spherical') return kind;
  if (kind === 'ball') return 'spherical';
  const compose: Partial<Record<JointKind, string>> = {
    rigid: 'weld the body instead (add_rigid_body with fixed: true) or merge the two bodies',
    cylindrical: 'compose a prismatic and a revolute joint on the same axis through an intermediate body',
    pin_slot: 'compose a prismatic joint along the slot and a revolute joint through an intermediate body',
    planar: 'compose two perpendicular prismatic joints and a revolute joint through intermediate bodies',
    cam: 'a cam follower is a kinematic coupling with no force model; use add_joint for kinematics',
  };
  return { refusal: `${kind} (${JOINT_DOF[kind].length} DOF) has no single MuJoCo joint: ${compose[kind] ?? 'unsupported'}` };
}
