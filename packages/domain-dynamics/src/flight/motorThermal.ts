/**
 * Motor winding temperature in the flight loop (13 FLT M3b): the two-node network of the drives work (`sim/actuators/thermal.ts`, PHY-23
 * TR-DRV-09: winding - housing - ambient), stepped exactly every physics step with each motor's copper loss i²·R(T) at its start-of-step
 * winding temperature. Only powertrains whose motor datasheet carries `thermal` get slots (after the aero slots), so a run without one keeps
 * its aux layout. The electrical law keeps the datasheet R (the temperature does not feed back into the motor voltage).
 */

import { resistanceAt, stepThermal } from '../sim/actuators/thermal';
import type { PowerRuntime } from './powerBlock';

/** Per motor: winding and housing rise over the ambient K, peak winding C, first time over the limit s (-1 = never), steps over the limit. */
const MOTOR_THERMAL = { windingRise: 0, housingRise: 1, peakWindingC: 2, overLimitTime: 3, overLimitSteps: 4 } as const;
const MOTOR_THERMAL_SLOTS = 5;

const slotsOf = (feed: PowerRuntime | undefined): number =>
  feed === undefined || feed.thermal === null ? 0 : MOTOR_THERMAL_SLOTS * feed.rotorIndexes.length;

/** Aux slots of the motor thermal state of a run's powertrains. */
export const thermalSlotCount = (power: readonly PowerRuntime[]): number => power.reduce((sum, feed) => sum + slotsOf(feed), 0);

/** First slot (relative to the thermal base) of motor `k` of powertrain `p`; -1 when that powertrain tracks no temperature. */
export function thermalOffset(power: readonly PowerRuntime[], p: number, k: number): number {
  if (k < 0 || power[p]?.thermal == null) return -1;
  let offset = 0;
  for (let q = 0; q < p; q++) offset += slotsOf(power[q]);
  return offset + MOTOR_THERMAL_SLOTS * k;
}

/** Initial thermal slots: every winding at the ambient, never over its limit. */
export function initialThermalAux(power: readonly PowerRuntime[], aux: Float64Array, base: number): void {
  power.forEach((feed, p) =>
    feed.rotorIndexes.forEach((_, k) => {
      const at = thermalOffset(power, p, k);
      if (at < 0) return;
      aux[base + at + MOTOR_THERMAL.peakWindingC] = feed.ambientC;
      aux[base + at + MOTOR_THERMAL.overLimitTime] = -1;
    }),
  );
}

/** Advance the winding of one motor at slot `at` by `dt` carrying `currentA` through its copper. */
export function stepMotorThermal(feed: PowerRuntime, aux: Float64Array, at: number, currentA: number, time: number, dt: number): void {
  const network = feed.thermal;
  if (network === null) return;
  const rise = aux[at + MOTOR_THERMAL.windingRise] as number;
  const powerW = currentA * currentA * resistanceAt(network, feed.ambientC + rise);
  const [winding, housing] = stepThermal(network, [rise, aux[at + MOTOR_THERMAL.housingRise] as number], powerW, dt);
  aux[at + MOTOR_THERMAL.windingRise] = winding;
  aux[at + MOTOR_THERMAL.housingRise] = housing;
  const windingC = feed.ambientC + winding;
  aux[at + MOTOR_THERMAL.peakWindingC] = Math.max(aux[at + MOTOR_THERMAL.peakWindingC] as number, windingC);
  if (windingC <= network.maxWindingC) return;
  if ((aux[at + MOTOR_THERMAL.overLimitTime] as number) < 0) aux[at + MOTOR_THERMAL.overLimitTime] = time;
  aux[at + MOTOR_THERMAL.overLimitSteps] = (aux[at + MOTOR_THERMAL.overLimitSteps] as number) + 1;
}

/** Winding temperatures of a powertrain's motors over a run (13 FLT M3b). */
export interface MotorThermalMetrics {
  readonly ambientC: number;
  readonly maxWindingC: number;
  /** Hottest winding of the run over the motors, C, and the motor (rotor id) it belongs to. */
  readonly peakWindingC: number;
  readonly hottestRotorId: string;
  readonly motors: readonly {
    readonly rotorId: string;
    readonly peakWindingC: number;
    readonly finalWindingC: number;
    readonly finalHousingC: number;
  }[];
  /** First time a winding passed maxWindingC, s; null = never. */
  readonly overLimitAtS: number | null;
  /** Largest share of the physics steps a motor spent over maxWindingC. */
  readonly overLimitFraction: number;
}

/** Thermal metrics of powertrain `p` (null without thermal data); `rotorIds` are the run's rotors, `final(slot)` reads an aux slot at the end. */
export function motorThermalMetrics(
  power: readonly PowerRuntime[],
  p: number,
  base: number,
  rotorIds: readonly string[],
  final: (slot: number) => number,
  physicsSteps: number,
): MotorThermalMetrics | null {
  const feed = power[p];
  const network = feed?.thermal ?? null;
  if (feed === undefined || network === null) return null;
  const motors = feed.rotorIndexes.map((index, k) => {
    const at = base + thermalOffset(power, p, k);
    return {
      rotorId: rotorIds[index] ?? '',
      peakWindingC: final(at + MOTOR_THERMAL.peakWindingC),
      finalWindingC: feed.ambientC + final(at + MOTOR_THERMAL.windingRise),
      finalHousingC: feed.ambientC + final(at + MOTOR_THERMAL.housingRise),
      overLimitTime: final(at + MOTOR_THERMAL.overLimitTime),
      overLimitSteps: final(at + MOTOR_THERMAL.overLimitSteps),
    };
  });
  const hottest = motors.reduce<(typeof motors)[number] | null>(
    (most, motor) => (most === null || motor.peakWindingC > most.peakWindingC ? motor : most),
    null,
  );
  const overTimes = motors.map((motor) => motor.overLimitTime).filter((time) => time >= 0);
  return {
    ambientC: feed.ambientC,
    maxWindingC: network.maxWindingC,
    peakWindingC: hottest?.peakWindingC ?? feed.ambientC,
    hottestRotorId: hottest?.rotorId ?? '',
    motors: motors.map(({ rotorId, peakWindingC, finalWindingC, finalHousingC }) => ({
      rotorId,
      peakWindingC,
      finalWindingC,
      finalHousingC,
    })),
    overLimitAtS: overTimes.length === 0 ? null : overTimes.reduce((least, time) => Math.min(least, time), Infinity),
    overLimitFraction: motors.reduce((most, motor) => Math.max(most, motor.overLimitSteps), 0) / physicsSteps,
  };
}
