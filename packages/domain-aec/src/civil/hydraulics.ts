/**
 * Gravity-pipe hydraulics in SI (metres, seconds, litres per second): Manning full-bore capacity,
 * partial-flow depth in a circular section, rational-method runoff.
 * @layer domain-aec/civil
 * @pure
 */

/** Depth ratio y/D at which a circular pipe carries its maximum discharge (about 1.076 Q full). */
const MAX_DISCHARGE_DEPTH_RATIO = 0.938;
const BISECTION_STEPS = 60;

export interface PartialFlow {
  /** Flow depth / diameter, 0..1 (1 when the pipe runs full or surcharged). */
  readonly depthRatio: number;
  /** Mean velocity (m/s). */
  readonly velocity: number;
  /** True when the flow exceeds the pipe's maximum open-channel discharge. */
  readonly surcharged: boolean;
}

/** Full-bore area (m^2) of a circular pipe of `diameter` metres. */
export function fullArea(diameter: number): number {
  return (Math.PI * diameter * diameter) / 4;
}

/** Manning full-bore discharge (m^3/s): Q = (1/n) A R^(2/3) S^(1/2); 0 when S <= 0. */
export function manningFullFlow(diameter: number, slope: number, manningN: number): number {
  if (!(slope > 0) || !(diameter > 0) || !(manningN > 0)) return 0;
  const hydraulicRadius = diameter / 4;
  return (fullArea(diameter) * hydraulicRadius ** (2 / 3) * Math.sqrt(slope)) / manningN;
}

function wettedArea(diameter: number, ratio: number): { area: number; theta: number } {
  const theta = 2 * Math.acos(1 - 2 * Math.min(ratio, 1));
  return { area: (diameter * diameter * (theta - Math.sin(theta))) / 8, theta };
}

/** Discharge (m^3/s) at depth ratio `ratio` (0..1) of a circular section. */
export function partialFlowDischarge(
  diameter: number,
  slope: number,
  manningN: number,
  ratio: number,
): number {
  if (!(slope > 0) || !(ratio > 0)) return 0;
  const { area, theta } = wettedArea(diameter, ratio);
  const radius = area / ((diameter * theta) / 2);
  return (area * radius ** (2 / 3) * Math.sqrt(slope)) / manningN;
}

/**
 * Depth ratio and velocity for discharge `flow` (m^3/s). Bisection on the rising branch of the
 * discharge curve; flows above the open-channel maximum are reported surcharged at ratio 1.
 */
export function solvePartialFlow(
  diameter: number,
  slope: number,
  manningN: number,
  flow: number,
): PartialFlow {
  if (!(flow > 0)) return { depthRatio: 0, velocity: 0, surcharged: false };
  if (!(slope > 0) || !(diameter > 0) || !(manningN > 0)) {
    return { depthRatio: 1, velocity: 0, surcharged: true };
  }
  const maximum = partialFlowDischarge(diameter, slope, manningN, MAX_DISCHARGE_DEPTH_RATIO);
  if (flow > maximum)
    return { depthRatio: 1, velocity: flow / fullArea(diameter), surcharged: true };
  let low = 0;
  let high = MAX_DISCHARGE_DEPTH_RATIO;
  for (let step = 0; step < BISECTION_STEPS; step += 1) {
    const middle = (low + high) / 2;
    if (partialFlowDischarge(diameter, slope, manningN, middle) < flow) low = middle;
    else high = middle;
  }
  const depthRatio = (low + high) / 2;
  return { depthRatio, velocity: flow / wettedArea(diameter, depthRatio).area, surcharged: false };
}

/** Rational method Q = C i A / 360 -> litres per second (i in mm/h, A in hectares). */
export function rationalFlowLps(
  runoffCoefficient: number,
  intensityMmPerHour: number,
  areaHa: number,
): number {
  return ((runoffCoefficient * intensityMmPerHour * areaHa) / 360) * 1000;
}
