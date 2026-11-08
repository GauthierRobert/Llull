/** Lamé thick cylinders and the interference-fit pressure (PHY-06 §5.2), operation for operation as validation/generate_cnt_reference.py. */

export interface Ring {
  /** Bore radius, mm (0 = solid shaft). */
  readonly innerRadius: number;
  readonly outerRadius: number;
  /** Plane-stress (effective) modulus and Poisson ratio. */
  readonly E: number;
  readonly nu: number;
}

/** Lamé constants A, B of u(r) = A r + B / r with sigma_r(ri) = -pIn, sigma_r(ro) = -pOut (plane stress). */
function constants(ri: number, ro: number, pIn: number, pOut: number, E: number, nu: number): { readonly A: number; readonly B: number } {
  const k = E / (1 - nu * nu);
  const a11 = k * (1 + nu);
  const a12 = (-k * (1 - nu)) / ri ** 2;
  const b1 = -pIn;
  const a21 = k * (1 + nu);
  const a22 = (-k * (1 - nu)) / ro ** 2;
  const b2 = -pOut;
  const det = a11 * a22 - a12 * a21;
  return { A: (b1 * a22 - a12 * b2) / det, B: (a11 * b2 - b1 * a21) / det };
}

/** Bore radius used for a solid shaft (the generator's 1e-9 x outer radius). */
const boreOf = (ring: Ring): number => Math.max(ring.innerRadius, 1e-9 * ring.outerRadius);

/** Radial displacement at r of `ring` loaded by pIn at its bore and pOut at its outer radius. */
function radialDisplacement(ring: Ring, pIn: number, pOut: number, r: number): number {
  const { A, B } = constants(boreOf(ring), ring.outerRadius, pIn, pOut, ring.E, ring.nu);
  return A * r + B / r;
}

/** Radial and hoop stress at r of `ring` loaded by pIn / pOut. */
export function ringStresses(ring: Ring, pIn: number, pOut: number, r: number): { readonly radial: number; readonly hoop: number } {
  const { A, B } = constants(boreOf(ring), ring.outerRadius, pIn, pOut, ring.E, ring.nu);
  const k = ring.E / (1 - ring.nu * ring.nu);
  return { radial: k * ((1 + ring.nu) * A - ((1 - ring.nu) * B) / r ** 2), hoop: k * ((1 + ring.nu) * A + ((1 - ring.nu) * B) / r ** 2) };
}

/** Contact pressure p with u_hub(b) - u_shaft(b) = radial interference (bracket doubled from [0, 1], then 300 bisections). */
export function interferencePressure(inner: Ring, outer: Ring, radialInterference: number): number {
  const b = inner.outerRadius;
  const f = (p: number): number => radialDisplacement(outer, p, 0, b) - radialDisplacement(inner, 0, p, b) - radialInterference;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 2000 && f(hi) < 0; k++) hi *= 2;
  for (let k = 0; k < 300; k++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Plane strain as plane stress with E -> E / (1 - nu^2), nu -> nu / (1 - nu). */
export const planeStrainRing = (ring: Ring): Ring => ({ ...ring, E: ring.E / (1 - ring.nu ** 2), nu: ring.nu / (1 - ring.nu) });
