/**
 * Powertrain operating point of a trim (13 FLT M5b): the battery / ESC / motor laws run_flight integrates (powerChain.ts) evaluated at the trimmed
 * rotor speeds and shaft torques, the pack at its initial state of charge. A point the run could not hold is a limit: a motor voltage above the
 * pack's terminal voltage (run_flight caps the speed there, packRpm), or the cut-off run_flight latches (packCutOff: a power the pack cannot
 * deliver, a terminal voltage under the cut-off, an empty pack).
 * A motor current above the datasheet peak is reported (run_flight counts it, it does not limit it). A CHECK of the trimmed point, not a
 * constrained solve: with more controls than equations another speed split might still fit (a symmetric vehicle has one).
 */

import type { PowerRuntime } from './powerBlock';
import { motorPoint, openCircuitVolts, packCutOff, solveChain } from './powerChain';

type PowerLimit = 'motor_voltage' | 'pack_power' | 'cutoff_voltage' | 'empty_pack';

interface TrimPowertrain {
  readonly id: string;
  readonly batteryId: string;
  readonly stateOfCharge: number;
  readonly openCircuitV: number;
  readonly busPowerW: number;
  /** null when the pack cannot deliver the power. */
  readonly packCurrentA: number | null;
  readonly terminalV: number | null;
  readonly cutoffV: number;
  /** Largest motor voltage over the terminal voltage (1 = full throttle). */
  readonly throttle: number | null;
  readonly motors: readonly {
    readonly rotorId: string;
    readonly rpm: number;
    readonly torqueNm: number;
    readonly currentA: number;
    readonly voltageV: number;
    readonly overPeakCurrent: boolean;
  }[];
  readonly peakCurrentA: number;
  /** What makes the point unholdable in run_flight, or null. */
  readonly limit: PowerLimit | null;
}

/** The operating point of every powertrain; `rotorIds` are the run's rotors (`PowerRuntime.rotorIndexes` index them), `loads` per rotor id. */
export function trimPowertrains(
  power: readonly PowerRuntime[],
  rotorIds: readonly string[],
  loads: ReadonlyMap<string, { readonly rpm: number; readonly torqueNm: number }>,
): TrimPowertrain[] {
  return power.map((feed) => {
    const soc = feed.battery.initialSoc;
    const ocv = openCircuitVolts(feed.pack, soc);
    const motors = feed.rotorIndexes.map((index) => {
      const rotorId = rotorIds[index] ?? '';
      const load = loads.get(rotorId) ?? { rpm: 0, torqueNm: 0 };
      const point = motorPoint(feed.motor, load.torqueNm, (load.rpm * 2 * Math.PI) / 60);
      return { rotorId, rpm: load.rpm, torqueNm: load.torqueNm, ...point, overPeakCurrent: point.currentA > feed.motor.peakCurrentA };
    });
    const { powerW: busPowerW, solved } = solveChain(feed.pack, feed.powertrain, ocv, motors);
    const throttle =
      solved === null || solved.terminalV <= 0
        ? null
        : motors.reduce((most, motor) => Math.max(most, motor.voltageV / solved.terminalV), 0);
    // a trim draws no charge: the state of charge after the point is the initial one (the run cuts off at t = 0 on an empty pack)
    const cutOff = packCutOff(feed.pack, solved, soc);
    const limit: PowerLimit | null = cutOff
      ? solved === null
        ? 'pack_power'
        : soc <= 0
          ? 'empty_pack'
          : 'cutoff_voltage'
      : throttle !== null && throttle > 1
        ? 'motor_voltage'
        : null;
    return {
      id: feed.powertrain.id,
      batteryId: feed.battery.id,
      stateOfCharge: soc,
      openCircuitV: ocv,
      busPowerW,
      packCurrentA: solved?.currentA ?? null,
      terminalV: solved?.terminalV ?? null,
      cutoffV: feed.pack.cutoffV,
      throttle,
      motors,
      peakCurrentA: feed.motor.peakCurrentA,
      limit,
    };
  });
}

/** Why the point of `powertrain` cannot be held, in words. */
export function powerLimitText(powertrain: TrimPowertrain): string {
  const volts = (value: number | null): string => (value === null ? 'none' : `${value.toPrecision(4)} V`);
  if (powertrain.limit === 'pack_power')
    return `powertrain '${powertrain.id}': pack '${powertrain.batteryId}' cannot deliver ${powertrain.busPowerW.toPrecision(4)} W (more than OCV² / 4R at SoC ${powertrain.stateOfCharge})`;
  if (powertrain.limit === 'empty_pack')
    return `powertrain '${powertrain.id}': pack '${powertrain.batteryId}' is empty (SoC ${powertrain.stateOfCharge})`;
  if (powertrain.limit === 'cutoff_voltage')
    return `powertrain '${powertrain.id}': the pack sags to ${volts(powertrain.terminalV)}, under its cut-off ${volts(powertrain.cutoffV)}`;
  const highest = powertrain.motors.reduce((most, motor) => Math.max(most, motor.voltageV), 0);
  const throttle = powertrain.throttle === null ? 'none' : powertrain.throttle.toPrecision(4);
  return `powertrain '${powertrain.id}': the motors need ${volts(highest)}, the pack gives ${volts(powertrain.terminalV)} (throttle ${throttle} > 1)`;
}
