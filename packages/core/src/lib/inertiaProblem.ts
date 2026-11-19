/** Physical admissibility of a rigid-body inertia tensor (add_rigid_body and the dynamics load validation share it). */

import { symmetricEigen, type Symmetric3 } from './symmetricEigen';

/** Relative slack on the triangle inequality of the principal moments (a thin rod or plate sits on the bound). */
const TRIANGLE_SLACK = 1e-9;

/** Why an inertia tensor [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] is not one a rigid body can have (principal moments > 0, each at most the sum of the other two), or null. */
export function inertiaProblem(tensor: Symmetric3): string | null {
  const principal = symmetricEigen(tensor);
  if (principal === null) return 'inertiaKgM2 has a non-finite component';
  const [a, b, c] = principal.moments;
  if (!(a > 0))
    return `inertiaKgM2 is not positive definite (principal moments ${principal.moments.map((m) => m.toPrecision(4)).join(', ')} kg·m²)`;
  if (c > (a + b) * (1 + TRIANGLE_SLACK))
    return `inertiaKgM2 breaks the triangle inequality: principal moment ${c.toPrecision(4)} > ${a.toPrecision(4)} + ${b.toPrecision(4)} kg·m² (no mass distribution has it)`;
  return null;
}
