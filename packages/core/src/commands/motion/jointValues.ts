import type { Joint, JointLimit } from '../../model/joints';

/** Current DOF values of a joint in `JOINT_DOF` order (a cam has none: its slide is computed). */
export function jointValues(joint: Joint): number[] {
  if (joint.kind === 'revolute') return [joint.angle];
  if (joint.kind === 'prismatic') return [joint.displacement];
  return [...joint.values];
}

/** The joint with DOF `index` set to `value` (other DOFs untouched). */
export function withJointValue(joint: Joint, index: number, value: number): Joint {
  if (joint.kind === 'revolute') return { ...joint, angle: value };
  if (joint.kind === 'prismatic') return { ...joint, displacement: value };
  return { ...joint, values: joint.values.map((v, i) => (i === index ? value : v)) };
}

/** `value` clamped into `limit`; `clamped` tells whether it moved. */
export function clampToLimit(value: number, limit: JointLimit | undefined): { value: number; clamped: boolean } {
  const clamped = Math.min(limit?.max ?? Infinity, Math.max(limit?.min ?? -Infinity, value));
  return { value: clamped, clamped: clamped !== value };
}

/** Index of the first DOF whose value lies outside its limit (tolerance for solver noise), else -1. */
export function violatedLimit(joint: Joint, values: readonly number[]): number {
  return values.findIndex((value, i) => {
    const limit = joint.limits?.[i];
    return limit !== undefined && (value < (limit.min ?? -Infinity) - 1e-9 || value > (limit.max ?? Infinity) + 1e-9);
  });
}
