/**
 * The power chain inside the flight block (13 FLT M3, TR-FLT-06): per step the motors' voltage and current from the rotors' shaft torque, the
 * pack current from the bus power, the state of charge, the rotor speed the pack voltage still sustains, and the low-voltage cut-off (the motors
 * stop and stay stopped). State lives in the block's aux array, `POWER_SLOTS` slots per powertrain.
 */

import {
  maxOmega,
  motorLaw,
  motorPoint,
  openCircuitVolts,
  packLaw,
  socAtOpenCircuit,
  solveBus,
  busPower,
  type MotorLaw,
  type PackLaw,
} from './powerChain';
import type { FlightBattery, FlightPowertrain } from './powerModel';

/** A powertrain compiled for one run. */
export interface PowerRuntime {
  readonly powertrain: FlightPowertrain;
  readonly battery: FlightBattery;
  readonly pack: PackLaw;
  readonly motor: MotorLaw;
  /** Indexes into the loop's rotors of the rotors this powertrain feeds. */
  readonly rotorIndexes: readonly number[];
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
} as const;
export const POWER_SLOTS = 12;

export function compilePower(powertrain: FlightPowertrain, battery: FlightBattery, rotorIds: readonly string[]): PowerRuntime {
  return {
    powertrain,
    battery,
    pack: packLaw(battery),
    motor: motorLaw(powertrain.motor),
    rotorIndexes: powertrain.rotorIds.map((id) => rotorIds.indexOf(id)).filter((index) => index >= 0),
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
  const solved = solveBus(runtime.pack, ocv, busPower(runtime.powertrain, motors));
  const currentA = solved === null ? 0 : solved.currentA;
  const volts = solved === null ? 0 : solved.terminalV;
  // charge and energy stop at an empty pack: only what is left of the SoC can be drawn in the last step
  const drawnAs = Math.min(currentA * dt, soc * runtime.pack.capacityAs);
  const next = soc - drawnAs / runtime.pack.capacityAs;
  aux[base + POWER.soc] = Math.max(0, next);
  aux[base + POWER.chargeAs] = (aux[base + POWER.chargeAs] as number) + currentA * dt;
  aux[base + POWER.energyJ] = (aux[base + POWER.energyJ] as number) + volts * currentA * dt;
  aux[base + POWER.voltage] = solved === null ? 0 : volts;
  aux[base + POWER.current] = currentA;
  aux[base + POWER.minVoltage] = Math.min(aux[base + POWER.minVoltage] as number, volts);
  aux[base + POWER.peakCurrent] = Math.max(aux[base + POWER.peakCurrent] as number, currentA);
  const motorPeak = Math.max(0, ...motors.map((motor) => motor.currentA));
  aux[base + POWER.peakMotorCurrent] = Math.max(aux[base + POWER.peakMotorCurrent] as number, motorPeak);
  if (motorPeak > runtime.motor.peakCurrentA) aux[base + POWER.overCurrentSteps] = (aux[base + POWER.overCurrentSteps] as number) + 1;
  const throttle = volts > 0 ? Math.max(0, ...motors.map((motor) => motor.voltageV / volts)) : 0;
  aux[base + POWER.peakThrottle] = Math.max(aux[base + POWER.peakThrottle] as number, throttle);
  if (solved === null || (currentA > 0 && volts < runtime.pack.cutoffV) || next <= 0) aux[base + POWER.cutoffTime] = time;
}

/**
 * Time (s) the pack still delivers `currentA` constant from state of charge `soc` before its terminal voltage reaches the cut-off:
 * the SoC where OCV = cut-off + R·I is the floor, so t = (soc - floor) · C / I; null without a current.
 */
export function remainingS(runtime: PowerRuntime, soc: number, currentA: number): number | null {
  if (!(currentA > 0)) return null;
  const floor = socAtOpenCircuit(runtime.pack, runtime.pack.cutoffV + runtime.pack.resistanceOhm * currentA);
  return (Math.max(0, soc - floor) * runtime.pack.capacityAs) / currentA;
}
