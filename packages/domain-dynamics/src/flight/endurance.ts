/**
 * Steady-load endurance of a powertrain (13 FLT M3, FR-FLT-06): rotors held at fixed speeds and shaft torques, the pack discharged along its
 * OCV(SoC) curve with its internal resistance until the cut-off. The same pack and motor laws as the flight block (`powerChain`).
 */

import { busPower, motorPoint, openCircuitVolts, solveBus } from './powerChain';
import type { MotorLoad, PowerRuntime } from './powerBlock';

type EnduranceLimit = 'cutoff_voltage' | 'empty' | 'pack_power' | 'motor_voltage' | 'no_load' | 'step_budget';

export interface Endurance {
  /** Seconds from the start state to the limit; null with no load. */
  readonly timeS: number | null;
  readonly limitedBy: EnduranceLimit;
  readonly usedMah: number;
  readonly energyWh: number;
  readonly finalSoc: number;
  /** Initial charge / initial current: the constant-current endurance, s (the sag-free upper bound); null with no load. */
  readonly capacityOverCurrentS: number | null;
  readonly initial: {
    readonly busPowerW: number;
    readonly currentA: number;
    readonly terminalV: number;
    /** Per rotor: motor terminal voltage V and current A. */
    readonly motors: readonly { readonly voltageV: number; readonly currentA: number }[];
    /** Largest motor voltage over the terminal voltage (> 1: the pack cannot spin the rotors that fast). */
    readonly throttle: number;
  };
}

/** Largest number of integration steps (the step is 0.05 % of the discharge time at the initial current, so ~2000 are needed). */
const MAX_STEPS = 100_000;
const STEP_SHARE = 5e-4;

/** Discharge of the pack of `feed` from state of charge `soc0` under the constant motor `loads`. */
export function constantLoadEndurance(feed: PowerRuntime, loads: readonly MotorLoad[], soc0: number): Endurance {
  const { pack, powertrain } = feed;
  const motors = loads.map((load) => motorPoint(feed.motor, load.torqueNm, (load.rpm * 2 * Math.PI) / 60));
  const power = busPower(powertrain, motors);
  const maxMotorV = Math.max(0, ...motors.map((motor) => motor.voltageV));
  const first = solveBus(pack, openCircuitVolts(pack, soc0), power);
  const initial = {
    busPowerW: power,
    currentA: first === null ? 0 : first.currentA,
    terminalV: first === null ? 0 : first.terminalV,
    motors,
    throttle: first === null || first.terminalV <= 0 ? Infinity : maxMotorV / first.terminalV,
  };
  const outcome = (timeS: number | null, limitedBy: EnduranceLimit, soc: number, chargeAs: number, energyJ: number): Endurance => ({
    timeS,
    limitedBy,
    usedMah: chargeAs / 3.6,
    energyWh: energyJ / 3600,
    finalSoc: soc,
    capacityOverCurrentS: initial.currentA > 0 ? (soc0 * pack.capacityAs) / initial.currentA : null,
    initial,
  });
  if (first === null) return outcome(0, 'pack_power', soc0, 0, 0);
  if (!(first.currentA > 0)) return outcome(null, 'no_load', soc0, 0, 0);
  const dt = Math.max(1e-3, (pack.capacityAs * STEP_SHARE) / first.currentA);
  let soc = soc0;
  let time = 0;
  let chargeAs = 0;
  let energyJ = 0;
  let previous = first.terminalV;
  for (let step = 0; step < MAX_STEPS; step++) {
    const solved = solveBus(pack, openCircuitVolts(pack, soc), power);
    if (solved === null) return outcome(time, 'pack_power', soc, chargeAs, energyJ);
    if (solved.terminalV < pack.cutoffV) {
      const share = previous > solved.terminalV ? (previous - pack.cutoffV) / (previous - solved.terminalV) : 0;
      const back = Math.min(1, Math.max(0, share));
      return outcome(time - dt * (1 - back), 'cutoff_voltage', soc, chargeAs, energyJ);
    }
    if (maxMotorV > solved.terminalV) return outcome(time, 'motor_voltage', soc, chargeAs, energyJ);
    const left = (soc * pack.capacityAs) / solved.currentA;
    if (left <= dt) {
      return outcome(time + left, 'empty', 0, chargeAs + solved.currentA * left, energyJ + solved.terminalV * solved.currentA * left);
    }
    soc -= (solved.currentA * dt) / pack.capacityAs;
    time += dt;
    chargeAs += solved.currentA * dt;
    energyJ += solved.terminalV * solved.currentA * dt;
    previous = solved.terminalV;
  }
  return outcome(time, 'step_budget', soc, chargeAs, energyJ);
}
