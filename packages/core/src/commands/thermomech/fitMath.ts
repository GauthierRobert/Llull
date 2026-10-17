/** Fit at temperature (PHY-04 TECHNICAL_SPEC §5.3): limit diameters scaled by each part's thermal strain, clearance, status, intent. Pure. */

import { hubBoreHoopStress, shrinkFitPressure } from './analytic';

export interface Limits {
  readonly nominal: number;
  readonly upper: number;
  readonly lower: number;
}

export type FitIntent = 'clearance' | 'interference' | 'transition';
export type FitStatus = 'clearance' | 'interference' | 'interference_possible' | 'clearance_possible';
export type FitCode = 'TMC_FIT_INTERFERENCE' | 'TMC_FIT_LOOSE';

export interface Range {
  readonly min: number;
  readonly max: number;
}

export interface Clearance {
  readonly holeDiameter: Range;
  readonly shaftDiameter: Range;
  readonly clearance: Range;
}

/** D(T) = (nominal + deviation)(1 + strain) for each limit; clearance min = hole min - shaft max, max = hole max - shaft min. */
export function clearanceAt(hole: Limits, shaft: Limits, holeStrain: number, shaftStrain: number): Clearance {
  const holeDiameter = { min: (hole.nominal + hole.lower) * (1 + holeStrain), max: (hole.nominal + hole.upper) * (1 + holeStrain) };
  const shaftDiameter = { min: (shaft.nominal + shaft.lower) * (1 + shaftStrain), max: (shaft.nominal + shaft.upper) * (1 + shaftStrain) };
  return {
    holeDiameter,
    shaftDiameter,
    clearance: { min: holeDiameter.min - shaftDiameter.max, max: holeDiameter.max - shaftDiameter.min },
  };
}

/** Intent from the clearance range at the specification temperature (where the limits apply unscaled). */
export function intentOf(clearance: Range): FitIntent {
  if (clearance.min >= 0) return 'clearance';
  if (clearance.max < 0) return 'interference';
  return 'transition';
}

export function statusOf(clearance: Range, intent: FitIntent): FitStatus {
  if (clearance.min >= 0) return 'clearance';
  if (clearance.max < 0) return 'interference';
  return intent === 'interference' ? 'clearance_possible' : 'interference_possible';
}

/** TMC_FIT_INTERFERENCE: clearance intent and c_min < 0; TMC_FIT_LOOSE: interference intent and c_max >= 0. */
export function codeOf(clearance: Range, intent: FitIntent): FitCode | undefined {
  if (intent === 'clearance' && clearance.min < 0) return 'TMC_FIT_INTERFERENCE';
  if (intent === 'interference' && clearance.max >= 0) return 'TMC_FIT_LOOSE';
  return undefined;
}

export interface LameInput {
  /** Hub outer radius c, shaft radius b = nominal / 2, same length unit as the limits. */
  readonly hubOuterRadius: number;
  readonly hubE: number;
  readonly hubNu: number;
  readonly shaftE: number;
  readonly shaftNu: number;
}

/** Contact pressure range and maximum hub bore hoop stress (MPa) for the interference range of one row; zero where there is clearance. */
export function lameAt(clearance: Range, nominal: number, lame: LameInput): { pressure: Range; hubHoopMax: number } {
  const input = { b: nominal / 2, c: lame.hubOuterRadius, hubE: lame.hubE, hubNu: lame.hubNu, shaftE: lame.shaftE, shaftNu: lame.shaftNu };
  const pressureOf = (diametralInterference: number): number =>
    diametralInterference > 0 ? shrinkFitPressure(diametralInterference / 2, input) : 0;
  const pressure = { min: pressureOf(-clearance.max), max: pressureOf(-clearance.min) };
  return { pressure, hubHoopMax: hubBoreHoopStress(pressure.max, input.b, input.c) };
}
