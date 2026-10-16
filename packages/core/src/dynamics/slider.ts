/**
 * Exact slider-crank kinematics (TR-FPR §5.4). Crank radius r, rod length l, lateral offset e of the cylinder axis from the crank axis
 * (0 = centred). Angles psi are measured from the TOP position (the crank angle where the piston is highest: the pin on the axis for a
 * centred cylinder). Any consistent length unit.
 *
 * x(psi)   = r(1 - cos psi) + l(1 - sqrt(1 - (r sin psi / l)^2))         piston travel from the top (centred cylinder)
 * dx/dpsi  = r [sin psi + lambda sin 2psi / (2 sqrt(1 - lambda^2 sin^2 psi))],  lambda = r / l
 * torque   T = F dx/dpsi (virtual work); rod force F / cos(beta); side thrust F tan(beta); sin(beta) = lambda sin psi
 */

export interface Slider {
  readonly r: number;
  readonly l: number;
  /** Lateral offset of the cylinder axis from the crank axis, same unit as r. */
  readonly offset: number;
  /** Pin angle (from the head direction) at which the piston is highest, rad. */
  readonly top: number;
}

/** Piston position along the head direction from the crank centre, for the pin at angle `alpha` from the head direction. */
function height(r: number, l: number, offset: number, alpha: number): number {
  return r * Math.cos(alpha) + Math.sqrt(l * l - (r * Math.sin(alpha) - offset) ** 2);
}

/** Angle of the highest piston position, rad: exact 0 for a centred cylinder, a search with golden-section refinement otherwise. */
function topAngle(r: number, l: number, offset: number): number {
  if (Math.abs(offset) < 1e-12 * l) return 0;
  const samples = 7200;
  let best = 0;
  let bestHeight = -Infinity;
  for (let i = 0; i < samples; i++) {
    const alpha = -Math.PI + ((2 * Math.PI) / samples) * i;
    const h = height(r, l, offset, alpha);
    if (h > bestHeight) [best, bestHeight] = [alpha, h];
  }
  const step = (2 * Math.PI) / samples;
  let [lo, hi] = [best - step, best + step];
  const ratio = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 80; i++) {
    const [a, b] = [hi - ratio * (hi - lo), lo + ratio * (hi - lo)];
    if (height(r, l, offset, a) > height(r, l, offset, b)) hi = b;
    else lo = a;
  }
  return (lo + hi) / 2;
}

export function createSlider(r: number, l: number, offset = 0): Slider {
  return { r, l, offset, top: topAngle(r, l, offset) };
}

/** Travel from the top position, >= 0. */
export function sliderTravel(s: Slider, psi: number): number {
  return height(s.r, s.l, s.offset, s.top) - height(s.r, s.l, s.offset, s.top + psi);
}

/** d(travel)/d(psi): crank torque per unit of force pushing the piston toward the crank. */
export function sliderRate(s: Slider, psi: number): number {
  const alpha = s.top + psi;
  const lateral = s.r * Math.sin(alpha) - s.offset;
  return s.r * Math.sin(alpha) + (lateral * s.r * Math.cos(alpha)) / Math.sqrt(s.l * s.l - lateral * lateral);
}

/** Rod angle to the cylinder axis, rad. */
export function rodAngle(s: Slider, psi: number): number {
  return Math.asin((s.r * Math.sin(s.top + psi) - s.offset) / s.l);
}

/** Stroke: highest minus lowest piston position (2 r for a centred cylinder). */
export function sliderStroke(s: Slider): number {
  let lowest = Infinity;
  for (let i = 0; i < 3600; i++) lowest = Math.min(lowest, height(s.r, s.l, s.offset, s.top + ((2 * Math.PI) / 3600) * i));
  return height(s.r, s.l, s.offset, s.top) - lowest;
}
