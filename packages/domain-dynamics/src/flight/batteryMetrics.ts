/** Battery numbers of a flight run (13 FLT M3, FR-FLT-06): charge, energy, current, voltage sag, cut-off and the endurance, from the block's aux state. */

import { powerBase } from './flightBlock';
import { POWER, remainingS, type PowerRuntime } from './powerBlock';

export interface BatteryMetrics {
  readonly batteryId: string;
  readonly initialSoc: number;
  readonly finalSoc: number;
  /** Charge drawn from the pack, mAh. */
  readonly usedChargeMah: number;
  /** Energy drawn at the pack terminals, Wh. */
  readonly energyWh: number;
  readonly meanElectricalPowerW: number;
  readonly meanCurrentA: number;
  readonly peakCurrentA: number;
  readonly finalCurrentA: number;
  readonly finalVoltageV: number;
  /** Lowest terminal voltage of a step, V (the sag under load). */
  readonly minVoltageV: number;
  readonly cutoffVoltageV: number;
  /** Time the low-voltage cut-off (or an empty / collapsed pack) stopped the motors; null = not reached. */
  readonly cutoffAtS: number | null;
  /** Largest motor current of a step, A, and the datasheet limit it is judged against. */
  readonly motorPeakCurrentA: number;
  readonly motorCurrentLimitA: number;
  /** Largest throttle (motor voltage / pack voltage) of a step; the speed cap uses the previous step's terminal voltage while this ratio divides by the present one, so it can exceed 1 by a small one-step lag (FLT-D26). */
  readonly peakThrottle: number;
  /** Share of the physics steps where the pack voltage limited a rotor's speed below its command. */
  readonly voltageLimitedFraction: number;
  readonly overCurrentFraction: number;
  /** Flight time to the cut-off: reached, or (an ESTIMATE, optimistic on a sloping OCV or a constant-power load; estimate_endurance integrates properly) the run time plus what the final current still allows (state of charge down to the cut-off floor). null = no load. */
  readonly enduranceS: number | null;
  readonly enduranceBasis: 'cutoff_reached' | 'extrapolated_at_final_current' | 'no_load';
}

/** Metrics of powertrain `index` of the run; `final(slot)` reads an aux slot at the last sample. */
export function batteryMetrics(
  feed: PowerRuntime,
  index: number,
  rotorCount: number,
  final: (slot: number) => number,
  durationS: number,
  physicsSteps: number,
): BatteryMetrics {
  const at = (field: number): number => final(powerBase(rotorCount, index) + field);
  const cutoff = at(POWER.cutoffTime);
  const finalCurrentA = at(POWER.current);
  const finalSoc = at(POWER.soc);
  const chargeAs = at(POWER.chargeAs);
  const ahead = cutoff >= 0 ? null : remainingS(feed, finalSoc, finalCurrentA);
  return {
    batteryId: feed.battery.id,
    initialSoc: feed.battery.initialSoc,
    finalSoc,
    usedChargeMah: chargeAs / 3.6,
    energyWh: at(POWER.energyJ) / 3600,
    meanElectricalPowerW: durationS > 0 ? at(POWER.energyJ) / durationS : 0,
    meanCurrentA: durationS > 0 ? chargeAs / durationS : 0,
    peakCurrentA: at(POWER.peakCurrent),
    finalCurrentA,
    finalVoltageV: at(POWER.voltage),
    minVoltageV: at(POWER.minVoltage),
    cutoffVoltageV: feed.pack.cutoffV,
    cutoffAtS: cutoff >= 0 ? cutoff : null,
    motorPeakCurrentA: at(POWER.peakMotorCurrent),
    motorCurrentLimitA: feed.motor.peakCurrentA,
    peakThrottle: at(POWER.peakThrottle),
    voltageLimitedFraction: at(POWER.limitedSteps) / physicsSteps,
    overCurrentFraction: at(POWER.overCurrentSteps) / physicsSteps,
    enduranceS: cutoff >= 0 ? cutoff : ahead === null ? null : durationS + ahead,
    enduranceBasis: cutoff >= 0 ? 'cutoff_reached' : ahead === null ? 'no_load' : 'extrapolated_at_final_current',
  };
}

/** Warnings of one powertrain's metrics (named codes, as the rotor-range warning). */
export function batteryWarnings(id: string, metrics: BatteryMetrics): string[] {
  const warnings: string[] = [];
  if (metrics.cutoffAtS !== null)
    warnings.push(
      `FLT_BATTERY_CUTOFF: battery '${metrics.batteryId}' of powertrain '${id}' hit its cut-off (${metrics.cutoffVoltageV.toPrecision(4)} V, state of charge ${metrics.finalSoc.toPrecision(3)}) at t = ${metrics.cutoffAtS.toPrecision(5)} s: the motors stopped`,
    );
  if (metrics.overCurrentFraction > 0)
    warnings.push(
      `FLT_MOTOR_CURRENT_LIMIT: powertrain '${id}' motor current peaked at ${metrics.motorPeakCurrentA.toPrecision(4)} A, over its ${metrics.motorCurrentLimitA.toPrecision(4)} A limit for ${(100 * metrics.overCurrentFraction).toPrecision(3)} % of the steps`,
    );
  if (metrics.voltageLimitedFraction > 0)
    warnings.push(
      `FLT_PACK_VOLTAGE_LIMITED: powertrain '${id}' could not reach the commanded rotor speed on its pack voltage for ${(100 * metrics.voltageLimitedFraction).toPrecision(3)} % of the steps`,
    );
  return warnings;
}
