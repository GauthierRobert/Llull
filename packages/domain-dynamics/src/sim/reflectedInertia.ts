/**
 * Inertia of a cluster of rigidly coupled joints seen at one of them: with q_k = c_k · q_j along the equality couplings, J_eff = Σ c_k² J_k.
 * Used to scale the acceleration-law constraint rows of end stops and backlash (DRV-M0 13.2) to the inertia they really push.
 */

export interface RigidLink {
  readonly a: string;
  readonly b: string;
  /** q_b = ratio · q_a. */
  readonly ratio: number;
}

/** kg·m² (kg for a prismatic joint) at `joint` of the rigidly coupled cluster it belongs to, or undefined when a member has no inertia. */
export function reflectedInertia(
  joint: string,
  links: readonly RigidLink[],
  own: (joint: string) => number | undefined,
): number | undefined {
  const coefficient = new Map<string, number>([[joint, 1]]);
  for (let pass = 0; pass <= links.length; pass++)
    for (const link of links) {
      const [a, b] = [coefficient.get(link.a), coefficient.get(link.b)];
      if (a !== undefined && b === undefined) coefficient.set(link.b, a * link.ratio);
      else if (b !== undefined && a === undefined && link.ratio !== 0) coefficient.set(link.a, b / link.ratio);
    }
  let total = 0;
  for (const [member, c] of coefficient) {
    const inertia = own(member);
    if (inertia === undefined) return undefined;
    total += c * c * inertia;
  }
  return total;
}
