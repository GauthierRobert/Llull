/**
 * Battery / ESC / motor laws of the power chain (13 FLT M3, TR-FLT-06), pure functions shared by the flight block and estimate_endurance.
 * Motor: the DC law of the datasheet (ke = kt, i = Q / kt + I0, V = kt·ω + R·i). ESC: constant efficiency or a map η(throttle, current),
 * throttle = V_motor / V_pack. Pack: V = OCV(SoC) - R_int·I with P_bus = V·I, so I = (OCV - sqrt(OCV² - 4·R_int·P)) / (2·R_int); the state of
 * charge drains at the Peukert rate I·(I / I_rated)^(k-1) (Peukert 1897; Linden's Handbook of Batteries, 4th ed., §3.2), I itself for k = 1.
 */

import type { DcMotorDatasheet } from '@core/model/drives';
import { interp1 } from '@lib/interp1';
import { pow } from '@lib/pow';
import type { FlightBattery, FlightPowertrain } from './powerModel';

/** A pack ready for the loop: pack-level voltages, charge in coulombs. */
export interface PackLaw {
  readonly capacityAs: number;
  readonly resistanceOhm: number;
  readonly cutoffV: number;
  readonly points: readonly (readonly [number, number])[];
  /** Peukert exponent and rated current (A); absent for k = 1. */
  readonly peukert?: { readonly exponent: number; readonly ratedCurrentA: number };
}

/** Rated discharge time of the Peukert law unless the battery gives one, h (the 1C rating of LiPo datasheets). */
export const DEFAULT_PEUKERT_RATED_HOURS = 1;

export function packLaw(battery: FlightBattery): PackLaw {
  const law: PackLaw = {
    capacityAs: battery.capacityMah * 3.6,
    resistanceOhm: battery.internalResistanceOhm,
    cutoffV: battery.cutoffVoltPerCell * battery.cellsSeries,
    points: battery.ocv.map(([soc, volts]) => [soc, volts * battery.cellsSeries] as const),
  };
  const exponent = battery.peukertExponent;
  if (exponent === undefined || exponent === 1) return law;
  const hours = battery.peukertRatedHours ?? DEFAULT_PEUKERT_RATED_HOURS;
  return { ...law, peukert: { exponent, ratedCurrentA: battery.capacityMah / 1000 / hours } };
}

/**
 * Current (A) at which `currentA` drains the rated charge (Peukert): I·(I / I_rated)^(k-1), so a constant I empties the pack in
 * C·(I_rated / I)^(k-1) / I; `currentA` itself without an exponent or without a current.
 */
export function drainCurrentA(pack: PackLaw, currentA: number): number {
  const law = pack.peukert;
  if (law === undefined || !(currentA > 0)) return currentA;
  return currentA * pow(currentA / law.ratedCurrentA, law.exponent - 1);
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

/**
 * Whether the pack is cut off at a bus solution `solved` (null: it cannot deliver the power) leaving it at state of charge `socAfter`: no
 * solution, a terminal voltage under the cut-off while it delivers current, or an empty pack (the ESC low-voltage cut-off latches on any of them).
 */
export function packCutOff(
  pack: PackLaw,
  solved: { readonly currentA: number; readonly terminalV: number } | null,
  socAfter: number,
): boolean {
  return solved === null || (solved.currentA > 0 && solved.terminalV < pack.cutoffV) || socAfter <= 0;
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

/** ESC efficiency of `powertrain` at a throttle and motor current: the map (bilinear, end values held) or the constant. */
export function escEfficiencyAt(powertrain: FlightPowertrain, throttle: number, currentA: number): number {
  const map = powertrain.escEfficiencyMap;
  if (map === undefined) return powertrain.escEfficiency;
  const rows = map.efficiency.map((row) => interp1(map.currentA, row, currentA));
  return interp1(map.throttle, rows, throttle);
}

type MotorPoint = { readonly currentA: number; readonly voltageV: number };

/**
 * Electrical power into the ESCs for motors at (voltage, current) pairs: Σ V·i / η plus the auxiliary load, W. `packVolts` is the pack voltage the
 * throttle V / V_pack of a map is read at (unused with a constant efficiency).
 */
export function busPower(powertrain: FlightPowertrain, motors: readonly MotorPoint[], packVolts: number): number {
  if (powertrain.escEfficiencyMap === undefined)
    return motors.reduce((sum, m) => sum + (m.voltageV * m.currentA) / powertrain.escEfficiency, 0) + powertrain.auxiliaryPowerW;
  const throttleOf = (m: MotorPoint): number => (packVolts > 0 ? m.voltageV / packVolts : 1);
  return (
    motors.reduce((sum, m) => sum + (m.voltageV * m.currentA) / escEfficiencyAt(powertrain, throttleOf(m), m.currentA), 0) +
    powertrain.auxiliaryPowerW
  );
}

/** Fixed-point sweeps of the map's throttle against the terminal voltage it gives (the map depends weakly on it: a few sweeps converge). */
const MAP_SWEEPS = 30;
const MAP_TOLERANCE = 1e-12;

/**
 * Bus power and pack solution for motors at `motors` at open-circuit voltage `ocv`: with a constant efficiency the power is fixed; with a map the
 * throttle is read at the terminal voltage, which depends on the power, so the two are iterated to a fixed point (relative 1e-12).
 */
export function solveChain(
  pack: PackLaw,
  powertrain: FlightPowertrain,
  ocv: number,
  motors: readonly MotorPoint[],
): { readonly powerW: number; readonly solved: { readonly currentA: number; readonly terminalV: number } | null } {
  let volts = ocv;
  let powerW = busPower(powertrain, motors, volts);
  let solved = solveBus(pack, ocv, powerW);
  if (powertrain.escEfficiencyMap === undefined) return { powerW, solved };
  for (let sweep = 0; sweep < MAP_SWEEPS && solved !== null; sweep++) {
    if (Math.abs(solved.terminalV - volts) <= MAP_TOLERANCE * ocv) break;
    volts = solved.terminalV;
    powerW = busPower(powertrain, motors, volts);
    solved = solveBus(pack, ocv, powerW);
  }
  return { powerW, solved };
}
