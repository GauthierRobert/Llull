/** Constant-area duct flow of a perfect gas with friction (Fanno) or heat addition (Rayleigh): ratios to the sonic (*) state (NACA Report 1135). */

export interface FannoState {
  readonly mach: number;
  /** 4 f̄ L* / D (Fanning friction; Darcy: f_D L* / D has the same value) */
  readonly frictionParameter: number;
  readonly pressureRatio: number;
  readonly temperatureRatio: number;
  readonly densityRatio: number;
  readonly totalPressureRatio: number;
  readonly velocityRatio: number;
}

export function fannoState(mach: number, gamma: number): FannoState {
  const m2 = mach * mach;
  const denominator = 2 + (gamma - 1) * m2;
  const temperatureRatio = (gamma + 1) / denominator;
  const frictionParameter = (1 - m2) / (gamma * m2) + ((gamma + 1) / (2 * gamma)) * Math.log(((gamma + 1) * m2) / denominator);
  return {
    mach,
    frictionParameter,
    pressureRatio: Math.sqrt(temperatureRatio) / mach,
    temperatureRatio,
    densityRatio: 1 / (mach * Math.sqrt(temperatureRatio)),
    totalPressureRatio: (denominator / (gamma + 1)) ** ((gamma + 1) / (2 * (gamma - 1))) / mach,
    velocityRatio: mach * Math.sqrt(temperatureRatio),
  };
}

export interface RayleighState {
  readonly mach: number;
  readonly pressureRatio: number;
  readonly temperatureRatio: number;
  readonly densityRatio: number;
  readonly totalTemperatureRatio: number;
  readonly totalPressureRatio: number;
  readonly velocityRatio: number;
}

export function rayleighState(mach: number, gamma: number): RayleighState {
  const m2 = mach * mach;
  const base = 1 + gamma * m2;
  const pressureRatio = (1 + gamma) / base;
  const velocityRatio = ((1 + gamma) * m2) / base;
  return {
    mach,
    pressureRatio,
    temperatureRatio: (m2 * (1 + gamma) ** 2) / base ** 2,
    densityRatio: 1 / velocityRatio,
    totalTemperatureRatio: (2 * (gamma + 1) * m2 * (1 + ((gamma - 1) / 2) * m2)) / base ** 2,
    totalPressureRatio: pressureRatio * ((2 + (gamma - 1) * m2) / (gamma + 1)) ** (gamma / (gamma - 1)),
    velocityRatio,
  };
}
