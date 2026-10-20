import type { Joint, Vec3 } from '../../model/types';
import { axisVector } from '../../lib/axis';
import { add3, cross3, dot3, normalize3, scale3, sub3 } from '../../lib/vec3';
import { applyMat3, matFromAxisAngle, matFromEulerXYZ, mulMat3, type Mat3 } from '../../lib/axisRotation';

/** A rigid motion p ↦ rotation·p + translation (world frame). */
export interface RigidMotion {
  readonly rotation: Mat3;
  readonly translation: Vec3;
}

export const REST: RigidMotion = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] };

export const moveBy = (motion: RigidMotion, p: Vec3): Vec3 => add3(applyMat3(motion.rotation, p), motion.translation);

/** `outer ∘ inner`: apply `inner` first. */
export const compose = (outer: RigidMotion, inner: RigidMotion): RigidMotion => ({
  rotation: mulMat3(outer.rotation, inner.rotation),
  translation: moveBy(outer, inner.translation),
});

/** Unit vector of the axis param (a zero vector stays zero). */
export function unitAxis(axis: 'x' | 'y' | 'z' | Vec3): Vec3 {
  const v = axisVector(axis);
  return Math.hypot(v[0], v[1], v[2]) > 0 ? normalize3(v) : v;
}

/** Two unit vectors that with unit `n` form a right-handed frame (u × v = n); for n = +Z they are +X and +Y. */
export function planeBasis(n: Vec3): [Vec3, Vec3] {
  const helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize3(sub3(helper, scale3(n, dot3(helper, n))));
  return [u, cross3(n, u)];
}

/** Rotation by `angle` about the line through `pivot` along unit `u`. */
const aboutPivot = (u: Vec3, angle: number, pivot: Vec3): RigidMotion => {
  const rotation = matFromAxisAngle(u, angle);
  return { rotation, translation: sub3(pivot, applyMat3(rotation, pivot)) };
};

const translation = (t: Vec3): RigidMotion => ({ rotation: REST.rotation, translation: t });

/**
 * Motion of instance b relative to instance a, in rest-pose world coordinates: M_b = M_a ∘ result. `values` follow `JOINT_DOF`.
 * Legacy `prismatic` places b's origin at `pivot + axis·value` (so it snaps b onto the pivot at 0); every other kind is rest-relative.
 */
export function jointMotion(joint: Joint, values: readonly number[], pivot: Vec3, bPosition: Vec3): RigidMotion {
  const u = unitAxis(joint.axis);
  const [v0 = 0, v1 = 0, v2 = 0] = values;
  switch (joint.kind) {
    case 'revolute':
      return aboutPivot(u, v0, pivot);
    case 'prismatic':
      return translation(sub3(add3(pivot, scale3(u, v0)), bPosition));
    case 'rigid':
      return REST;
    case 'cylindrical': {
      const turn = aboutPivot(u, v0, pivot);
      return { rotation: turn.rotation, translation: add3(turn.translation, scale3(u, v1)) };
    }
    case 'pin_slot': {
      const turn = aboutPivot(u, v0, pivot);
      return { rotation: turn.rotation, translation: add3(turn.translation, scale3(unitAxis(joint.slotAxis), v1)) };
    }
    case 'planar': {
      const [eu, ev] = planeBasis(u);
      const turn = aboutPivot(u, v2, pivot);
      return { rotation: turn.rotation, translation: add3(turn.translation, add3(scale3(eu, v0), scale3(ev, v1))) };
    }
    case 'ball': {
      const rotation = matFromEulerXYZ([v0, v1, v2]);
      return { rotation, translation: sub3(pivot, applyMat3(rotation, pivot)) };
    }
    case 'cam':
      return translation(scale3(u, v0));
  }
}
