/**
 * The power chain inside the flight block (13 FLT M3, TR-FLT-06): per step the motors' voltage and current from the rotors' shaft torque, the
 * pack current from the bus power, the state of charge, the rotor speed the pack voltage still sustains, and the low-voltage cut-off (the motors
 * stop and stay stopped). State lives in the block's aux array, `POWER_SLOTS` slots per powertrain.
 */

import {
  drainCurrentA,
  maxOmega,
  motorLaw,
  motorPoint,
  openCircuitVolts,
  packCutOff,
  packLaw,
  socAtOpenCircuit,
  solveChain,
  type MotorLaw,
  type PackLaw,
} from './powerChain';
import type { FlightBattery, FlightPowertrain } from './powerModel';
import { maxOf } from '@lib/arrayExtrema';
import { thermalParams, type ThermalParams } from '../sim/actuators/thermal';

/** A powertrain compiled for one run. */
export interface PowerRuntime {
  readonly powertrain: FlightPowertrain;
  readonly battery: FlightBattery;
  readonly pack: PackLaw;
  readonly motor: MotorLaw;
  /** Indexes into the loop's rotors of the rotors this powertrain feeds. */
  readonly rotorIndexes: readonly number[];
  /** Winding thermal network of the motor (its datasheet's `thermal`), or null: no temperature is tracked. */
  readonly thermal: ThermalParams | null;
  /** Ambient of the network, C. */
  readonly ambientC: number;
}

/** Ambient of the motor thermal network unless the powertrain gives one, C (the datasheet reference temperature). */
export const DEFAULT_MOTOR_AMBIENT_C = 25;

/**
 * The defaulted inputs of a powertrain as a run reads them: its stored `defaulted`, plus `motorAmbientC` when the motor carries thermal data and no
 * ambient is stored (a powertrain saved before FLT-M3b, whose `thermal` datasheet was stored but not read, has no such flag).
 */
export function powertrainDefaulted(powertrain: FlightPowertrain): readonly string[] {
  const implicit = powertrain.motor.thermal !== undefined && powertrain.motorAmbientC === undefined;
  return implicit && !powertrain.defaulted.includes('motorAmbientC') ? [...powertrain.defaulted, 'motorAmbientC'] : powertrain.defaulted;
}

/** Per powertrain: state of charge, charge drawn C, energy drawn at the terminals J, terminal V, current A, lowest V, peak A, cut-off time s (-1 = none), steps limited by the pack voltage, steps over the motor's peak current, peak motor current A, peak throttle. */
export const POWER = {
  soc: 0,
  chargeAs: 1,
  energyJ: 2,
  voltage: 3,
  current: 4,
  minVoltage: 5,
  peakCurrent: 6,
  cutoffTime: 7,
  limitedSteps: 8,
  overCurrentSteps: 9,
  peakMotorCurrent: 10,
  peakThrottle: 11,
  /** Steps whose ESC map fixed point was not met to its residual (FLT_ESC_MAP_NO_FIXED_POINT). */
  mapUnsolvedSteps: 12,
} as const;
export const POWER_SLOTS = 13;

export function compilePower(powertrain: FlightPowertrain, battery: FlightBattery, rotorIds: readonly string[]): PowerRuntime {
  return {
    powertrain,
    battery,
    pack: packLaw(battery),
    motor: motorLaw(powertrain.motor),
    rotorIndexes: powertrain.rotorIds.map((id) => rotorIds.indexOf(id)).filter((index) => index >= 0),
    thermal: thermalParams(powertrain.motor),
    ambientC: powertrain.motorAmbientC ?? DEFAULT_MOTOR_AMBIENT_C,
  };
}

/** Initial aux slots of a powertrain. */
export function initialPowerAux(runtime: PowerRuntime, aux: Float64Array, base: number): void {
  const volts = openCircuitVolts(runtime.pack, runtime.battery.initialSoc);
  aux[base + POWER.soc] = runtime.battery.initialSoc;
  aux[base + POWER.voltage] = volts;
  aux[base + POWER.minVoltage] = volts;
  aux[base + POWER.cutoffTime] = -1;
}

const isCutOff = (aux: Float64Array, base: number): boolean => {
  const at = aux[base + POWER.cutoffTime];
  return at !== undefined && at >= 0;
};

/**
 * Rotor speed (rev/min) the pack lets the motor of a rotor turn, given the speed `rpm` asked and the shaft torque `torqueNm` it needs: 0 after the
 * cut-off, else `rpm` capped so the motor voltage kt·ω + R·i stays below the terminal voltage of the last step (full throttle).
 */
export function packRpm(runtime: PowerRuntime, aux: Float64Array, base: number, rpm: number, torqueNm: number): number {
  if (isCutOff(aux, base)) return 0;
  const omega = (rpm * 2 * Math.PI) / 60;
  const available = aux[base + POWER.voltage] as number;
  if (motorPoint(runtime.motor, torqueNm, omega).voltageV <= available) return rpm;
  aux[base + POWER.limitedSteps] = (aux[base + POWER.limitedSteps] as number) + 1;
  return (maxOmega(runtime.motor, torqueNm, omega, available) * 60) / (2 * Math.PI);
}

/** The motor of one rotor at the step: its shaft torque (N·m) at its speed (rev/min). */
export interface MotorLoad {
  readonly torqueNm: number;
  readonly rpm: number;
}

/** Advance the pack by `dt` with the motors at `loads`: bus power, current, state of charge, cut-off. */
export function stepPower(
  runtime: PowerRuntime,
  aux: Float64Array,
  base: number,
  loads: readonly MotorLoad[],
  time: number,
  dt: number,
): void {
  if (isCutOff(aux, base)) {
    aux[base + POWER.current] = 0;
    return;
  }
  const soc = aux[base + POWER.soc] as number;
  const ocv = openCircuitVolts(runtime.pack, soc);
  const motors = loads.map((load) => motorPoint(runtime.motor, load.torqueNm, (load.rpm * 2 * Math.PI) / 60));
  const { solved, converged } = solveChain(runtime.pack, runtime.powertrain, ocv, motors);
  if (!converged) aux[base + POWER.mapUnsolvedSteps] = (aux[base + POWER.mapUnsolvedSteps] as number) + 1;
  const currentA = solved === null ? 0 : solved.currentA;
  const volts = solved === null ? 0 : solved.terminalV;
  // the state of charge stops at an empty pack: only what is left of it can be drained in the last step (at the Peukert rate)
  const drawnAs = Math.min(drainCurrentA(runtime.pack, currentA) * dt, soc * runtime.pack.capacityAs);
  const next = soc - drawnAs / runtime.pack.capacityAs;
  aux[base + POWER.soc] = Math.max(0, next);
  aux[base + POWER.chargeAs] = (aux[base + POWER.chargeAs] as number) + currentA * dt;
  aux[base + POWER.energyJ] = (aux[base + POWER.energyJ] as number) + volts * currentA * dt;
  aux[base + POWER.voltage] = solved === null ? 0 : volts;
  aux[base + POWER.current] = currentA;
  aux[base + POWER.minVoltage] = Math.min(aux[base + POWER.minVoltage] as number, volts);
  aux[base + POWER.peakCurrent] = Math.max(aux[base + POWER.peakCurrent] as number, currentA);
  const motorPeak = Math.max(0, maxOf(motors.map((motor) => motor.currentA)));
  aux[base + POWER.peakMotorCurrent] = Math.max(aux[base + POWER.peakMotorCurrent] as number, motorPeak);
  if (motorPeak > runtime.motor.peakCurrentA) aux[base + POWER.overCurrentSteps] = (aux[base + POWER.overCurrentSteps] as number) + 1;
  const throttle = volts > 0 ? Math.max(0, maxOf(motors.map((motor) => motor.voltageV / volts))) : 0;
  aux[base + POWER.peakThrottle] = Math.max(aux[base + POWER.peakThrottle] as number, throttle);
  if (packCutOff(runtime.pack, solved, next)) aux[base + POWER.cutoffTime] = time;
}

/**
 * Time (s) the pack still delivers `currentA` constant from state of charge `soc` before its terminal voltage reaches the cut-off:
 * the SoC where OCV = cut-off + R·I is the floor, so t = (soc - floor) · C / I_drain (I_drain = I without a Peukert exponent); null without a current.
 */
export function remainingS(runtime: PowerRuntime, soc: number, currentA: number): number | null {
  if (!(currentA > 0)) return null;
  const floor = socAtOpenCircuit(runtime.pack, runtime.pack.cutoffV + runtime.pack.resistanceOhm * currentA);
  return (Math.max(0, soc - floor) * runtime.pack.capacityAs) / drainCurrentA(runtime.pack, currentA);
}
