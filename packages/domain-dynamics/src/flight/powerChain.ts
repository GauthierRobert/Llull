/**
 * Battery / ESC / motor laws of the power chain (13 FLT M3, TR-FLT-06), pure functions shared by the flight block and estimate_endurance.
 * Motor: the DC law of the datasheet (ke = kt, i = Q / kt + I0, V = kt·ω + R·i). ESC: constant efficiency, throttle = V_motor / V_pack.
 * Pack: V = OCV(SoC) - R_int·I with P_bus = V·I, so I = (OCV - sqrt(OCV² - 4·R_int·P)) / (2·R_int).
 */

import type { DcMotorDatasheet } from '@core/model/drives';
import type { FlightBattery, FlightPowertrain } from './powerModel';

/** A pack ready for the loop: pack-level voltages, charge in coulombs. */
export interface PackLaw {
  readonly capacityAs: number;
  readonly resistanceOhm: number;
  readonly cutoffV: number;
  readonly points: readonly (readonly [number, number])[];
}

export function packLaw(battery: FlightBattery): PackLaw {
  return {
    capacityAs: battery.capacityMah * 3.6,
    resistanceOhm: battery.internalResistanceOhm,
    cutoffV: battery.cutoffVoltPerCell * battery.cellsSeries,
    points: battery.ocv.map(([soc, volts]) => [soc, volts * battery.cellsSeries] as const),
  };
}

/** Open-circuit voltage of the pack at state of charge `soc` (linear between the table points, held flat outside). */
export function openCircuitVolts(pack: PackLaw, soc: number): number {
  const { points } = pack;
  const first = points[0] ?? [0, 0];
  const last = points[points.length - 1] ?? first;
  if (soc <= first[0]) return first[1];
  if (soc >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const hi = points[i];
    const lo = points[i - 1];
    if (hi === undefined || lo === undefined || soc > hi[0]) continue;
    return lo[1] + ((soc - lo[0]) / (hi[0] - lo[0])) * (hi[1] - lo[1]);
  }
  return last[1];
}

/** Lowest state of charge whose open-circuit voltage is `volts` (the table is non-decreasing; clamped to its ends). */
export function socAtOpenCircuit(pack: PackLaw, volts: number): number {
  const { points } = pack;
  const first = points[0] ?? [0, 0];
  const last = points[points.length - 1] ?? first;
  if (volts <= first[1]) return first[0];
  if (volts >= last[1]) return last[0];
  for (let i = 1; i < points.length; i++) {
    const hi = points[i];
    const lo = points[i - 1];
    if (hi === undefined || lo === undefined || volts > hi[1]) continue;
    return hi[1] === lo[1] ? lo[0] : lo[0] + ((volts - lo[1]) / (hi[1] - lo[1])) * (hi[0] - lo[0]);
  }
  return last[0];
}

/** Pack current and terminal voltage delivering `powerW` at open-circuit voltage `ocv`; null when the pack cannot (P > OCV² / 4R). */
export function solveBus(pack: PackLaw, ocv: number, powerW: number): { readonly currentA: number; readonly terminalV: number } | null {
  if (powerW <= 0) return { currentA: 0, terminalV: ocv };
  const r = pack.resistanceOhm;
  const disc = ocv * ocv - 4 * r * powerW;
  if (disc < 0 || ocv <= 0) return null;
  const currentA = r > 0 ? (ocv - Math.sqrt(disc)) / (2 * r) : powerW / ocv;
  return { currentA, terminalV: ocv - r * currentA };
}

/** The DC law of a datasheet motor, direct drive. */
export interface MotorLaw {
  readonly kt: number;
  readonly resistanceOhm: number;
  readonly noLoadCurrentA: number;
  /** Largest current the drive may command, A (datasheet peak, default U / R). */
  readonly peakCurrentA: number;
}

export function motorLaw(sheet: DcMotorDatasheet): MotorLaw {
  return {
    kt: sheet.torqueConstantNmPerA,
    resistanceOhm: sheet.terminalResistanceOhm,
    noLoadCurrentA: sheet.noLoadCurrentA === undefined ? 0 : sheet.noLoadCurrentA,
    peakCurrentA: sheet.peakCurrentA ?? sheet.nominalVoltageV / sheet.terminalResistanceOhm,
  };
}

/** Motor current (A) and terminal voltage (V) carrying shaft torque `torqueNm` at `omega` rad/s; a stopped motor draws nothing. */
export function motorPoint(law: MotorLaw, torqueNm: number, omega: number): { readonly currentA: number; readonly voltageV: number } {
  if (omega <= 0) return { currentA: 0, voltageV: 0 };
  const currentA = torqueNm / law.kt + law.noLoadCurrentA;
  return { currentA, voltageV: law.kt * omega + law.resistanceOhm * currentA };
}

/**
 * Largest shaft speed (rad/s) a terminal voltage `volts` sustains when the load torque follows `torqueRef · (ω / omegaRef)²` (a propeller at
 * a fixed advance ratio): the positive root of kt·ω + R·(c·ω² / kt + I0) = volts.
 */
export function maxOmega(law: MotorLaw, torqueRef: number, omegaRef: number, volts: number): number {
  const c = omegaRef > 0 ? torqueRef / (omegaRef * omegaRef) : 0;
  const a = (law.resistanceOhm * c) / law.kt;
  const free = volts - law.resistanceOhm * law.noLoadCurrentA;
  if (free <= 0) return 0;
  return a > 0 ? (2 * free) / (law.kt + Math.sqrt(law.kt * law.kt + 4 * a * free)) : free / law.kt;
}

/** Electrical power into the ESCs for motors at (voltage, current) pairs: Σ V·i / η plus the auxiliary load, W. */
export function busPower(
  powertrain: FlightPowertrain,
  motors: readonly { readonly currentA: number; readonly voltageV: number }[],
): number {
  return motors.reduce((sum, m) => sum + (m.voltageV * m.currentA) / powertrain.escEfficiency, 0) + powertrain.auxiliaryPowerW;
}
