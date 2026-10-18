/**
 * Road-load power of a vehicle on a grade with wind, and the track-cycling hour-record model:
 * - steady road load (Martin, Milliken, Cobb, McFadden & Coggan 1998, J. Appl. Biomech. 14:276-291, P_KE = 0); the bicycle terms Fw (wheel
 *   rotation drag area) and the 91 + 8.7 V mW bearing loss are zero for a generic vehicle:
 *   P = [½ρ(CdA + Fw)V_A²V_G + V_G Crr m g cos(atan G) + bearings + V_G m g sin(atan G)] / η_drivetrain
 * - Bassett, Kyle, Passfield, Broker & Burke 1999, Med. Sci. Sports Exerc. 31:1665-1676, eq. 8 (V in km/h, velodrome):
 *   P = K (0.00953 M_t V + 0.00775 V² + K1 A_f 0.007551 V³), A_f = 0.0293 H^0.725 M^0.425 + 0.0604, M_t = M + 10 kg
 */

import { bisect } from '@lib/bisect';

/** Bicycle preset of Martin et al. 1998 (road tyres Crr, wheel drag area Fw m², chain drivetrain efficiency). */
export const BICYCLE_DEFAULTS = { crr: 0.0032, wheelAreaM2: 0.0044, drivetrainEfficiency: 0.976 } as const;
export const GRAVITY = 9.80665;

export interface RoadLoadInputs {
  readonly massKg: number;
  readonly cdA: number;
  readonly crr: number;
  readonly wheelAreaM2: number;
  /** Drivetrain efficiency (input power -> wheel power), (0, 1]. */
  readonly drivetrainEfficiency: number;
  /** Rise over run (0.05 = 5 %). */
  readonly grade: number;
  /** Air speed component along travel added to the ground speed (+ headwind, - tailwind), m/s. */
  readonly headwindMS: number;
  readonly densityKgM3: number;
  readonly bearingLosses: boolean;
}

export interface RoadLoadPower {
  readonly aeroW: number;
  readonly rollingW: number;
  readonly bearingW: number;
  readonly gravityW: number;
  /** Power at the drivetrain input (crank, motor shaft): sum / η. */
  readonly totalW: number;
}

export function roadLoadPower(input: RoadLoadInputs, groundSpeed: number): RoadLoadPower {
  const airSpeed = groundSpeed + input.headwindMS;
  const slope = Math.atan(input.grade);
  const aeroW = 0.5 * input.densityKgM3 * (input.cdA + input.wheelAreaM2) * airSpeed * Math.abs(airSpeed) * groundSpeed;
  const rollingW = groundSpeed * input.crr * input.massKg * GRAVITY * Math.cos(slope);
  const bearingW = input.bearingLosses ? groundSpeed * (91 + 8.7 * groundSpeed) * 1e-3 : 0;
  const gravityW = groundSpeed * input.massKg * GRAVITY * Math.sin(slope);
  return { aeroW, rollingW, bearingW, gravityW, totalW: (aeroW + rollingW + bearingW + gravityW) / input.drivetrainEfficiency };
}

/** Largest steady speed searched (m/s, 360 km/h). */
export const MAX_GROUND_SPEED_MS = 100;

/**
 * Steady ground speed delivering `powerW` at the drivetrain input (the larger root when the curve is not monotone, e.g. downhill).
 * @invariant powerW > 0 (callers check)
 * @failure the power exceeds what 100 m/s needs -> null
 */
export function roadLoadSpeed(input: RoadLoadInputs, powerW: number): number | null {
  const steps = 400;
  let previous = 0;
  for (let k = steps; k >= 1; k -= 1) {
    const speed = (MAX_GROUND_SPEED_MS * k) / steps;
    if (k === steps && roadLoadPower(input, speed).totalW < powerW) return null;
    if (roadLoadPower(input, speed).totalW < powerW) {
      const range = bisect((v) => roadLoadPower(input, v).totalW < powerW, speed, previous, 80);
      return (range.low + range.high) / 2;
    }
    previous = speed;
  }
  const range = bisect((v) => roadLoadPower(input, v).totalW < powerW, 0, previous, 80);
  return (range.low + range.high) / 2;
}

export interface BassettInputs {
  readonly riderHeightM: number;
  readonly riderMassKg: number;
  readonly bikeMassKg: number;
  /** Aerodynamic factor K1 = Kd·Kpo·Kb·Kc·Kh. */
  readonly k1: number;
  /** External factor K (track roughness etc.). */
  readonly k: number;
}

/** Frontal area of rider + bicycle, m² (Bassett 1999 eq. 7). */
export const bassettFrontalArea = (heightM: number, massKg: number): number => 0.0293 * heightM ** 0.725 * massKg ** 0.425 + 0.0604;

/** Power in W at `speedKmh` (Bassett 1999 eq. 8). */
export function bassettPower(input: BassettInputs, speedKmh: number): number {
  const totalMass = input.riderMassKg + input.bikeMassKg;
  const area = bassettFrontalArea(input.riderHeightM, input.riderMassKg);
  return input.k * (0.00953 * totalMass * speedKmh + 0.00775 * speedKmh ** 2 + input.k1 * area * 0.007551 * speedKmh ** 3);
}

/** Speed in km/h at `powerW` (eq. 8 is monotone in V). */
export function bassettSpeed(input: BassettInputs, powerW: number): number {
  const range = bisect((v) => bassettPower(input, v) < powerW, 0, 150, 100);
  return (range.low + range.high) / 2;
}

/** Air density ratio at `altitudeM` from the polytropic atmosphere of Bassett 1999 eq. 5 (n 1.235, R 287.1, T1 288 K, g 9.807). */
export function bassettDensityRatio(altitudeM: number): number {
  const n = 1.235;
  return (1 - (9.807 * (n - 1) * altitudeM) / (n * 287.1 * 288)) ** (1 / (n - 1));
}
