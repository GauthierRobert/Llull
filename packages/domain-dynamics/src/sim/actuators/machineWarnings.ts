/** What a run says about the machine kinds of PHY-23 DRV-M4: lost steps of a stepper, the voltage the PMSM envelope did not count, the induction model form. */

import type { SimulationTrace } from '@core/dynamics/physicsEngine';
import { elementAt } from '@lib/elementAt';
import { AUX } from './controller';
import type { DriveRuntime } from './driveRuntime';
import { phaseVoltageLimit } from './pmsm';

export interface StepperRunData {
  /** Net full steps lost at the end of the run (whole electrical periods of 4 steps, signed: positive = the rotor lags the field). */
  readonly lostSteps: number;
  /** Largest |steps lost| reached in the run. */
  readonly peakLostSteps: number;
  /** Time of the first lost step, s; null when none was lost. */
  readonly firstLostS: number | null;
  /** Largest |electrical lag| in the run, degrees (stable up to 90). */
  readonly peakLagDeg: number;
}

/** Largest omega_n x dt (and c x dt / J) the explicit stepper step keeps accurate and stable. */
const STEPPER_STEP_LIMIT = 0.2;

const slot = (trace: SimulationTrace, run: DriveRuntime, offset: number): number[] => trace.aux?.[run.base + offset] ?? [];

/** The lost-step account of a stepper's run, or null for another kind. */
export function stepperRunData(run: DriveRuntime, trace: SimulationTrace): StepperRunData | null {
  if (run.machine.kind !== 'stepper') return null;
  const lost = slot(trace, run, AUX.lostSteps);
  const lag = slot(trace, run, AUX.lag);
  const times = slot(trace, run, AUX.lostTime);
  const first = times[times.length - 1];
  return {
    lostSteps: lost.length === 0 ? 0 : elementAt(lost, lost.length - 1),
    peakLostSteps: lost.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0),
    firstLostS: first !== undefined && first >= 0 ? first : null,
    peakLagDeg: (lag.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0) * 180) / Math.PI,
  };
}

/** The warnings of a motor's run that belong to its kind (stepper steps lost or recovered overshoot, PMSM voltage over the bus limit, the induction steady-state form). */
export function machineWarnings(run: DriveRuntime, trace: SimulationTrace, peakVoltageV: number, timestep: number): string[] {
  const { machine, motor } = run;
  if (machine.kind === 'stepper' && motor.kind === 'stepper') {
    const data = stepperRunData(run, trace);
    const rotor = motor.datasheet.rotorInertiaKgM2;
    const natural = Math.sqrt((machine.params.holdingTorqueNm * machine.params.rotorTeeth) / rotor);
    const coarse = natural * timestep > STEPPER_STEP_LIMIT || (machine.params.dampingNmsPerRad * timestep) / rotor > STEPPER_STEP_LIMIT;
    const timestepWarning = coarse
      ? [
          `DRV_STEPPER_TIMESTEP: stepper '${motor.id}' rings at up to ${(natural / (2 * Math.PI)).toPrecision(4)} Hz (conservative estimate: rotor inertia only, holding torque, so a loaded rotor rings lower) and the step is ${timestep} s: the field torque and the damping are applied explicitly per step, ` +
            `keep omega_n x dt and c x dt / J below ${STEPPER_STEP_LIMIT} (timestep <= ${(STEPPER_STEP_LIMIT / natural).toPrecision(2)} s)`,
        ]
      : [];
    if (data === null || data.peakLostSteps === 0) return timestepWarning;
    if (data.lostSteps === 0)
      return [
        ...timestepWarning,
        `DRV_STEPPER_OVERSHOOT: stepper '${motor.id}' fell behind its field by more than half an electrical period (largest ${data.peakLostSteps} steps, first at t = ${data.firstLostS?.toPrecision(4)} s) and recovered: ` +
          'no step is lost at the end, but the load or the step rate is at the pull-out limit (the transient is not a stable operating point)',
      ];
    return [
      ...timestepWarning,
      `DRV_STEPS_LOST: stepper '${motor.id}' lost ${data.lostSteps} full steps by the end (first at t = ${data.firstLostS?.toPrecision(4)} s, largest ${data.peakLostSteps}): ` +
        'the load or the step rate is beyond the pull-out torque; the position it reports is not the commanded one',
    ];
  }
  if (machine.kind === 'pmsm') {
    const limit = phaseVoltageLimit(machine.limits.busVoltageV);
    return peakVoltageV > limit * (1 + 1e-9)
      ? [
          `DRV_PMSM_VOLTAGE_OVER: motor '${motor.id}' needed ${peakVoltageV.toPrecision(4)} V of phase voltage, above the ${limit.toPrecision(4)} V the bus gives (V_bus/√3): ` +
            'the torque envelope neglects the winding resistance, so the stator voltage drop R·i pushes the real limit slightly lower',
        ]
      : [];
  }
  if (machine.kind === 'induction')
    return [
      `DRV_INDUCTION_QUASI_STEADY: induction motor '${motor.id}' uses the steady-state torque at the instantaneous slip (no flux transients): ` +
        'valid when the speed changes slowly against the rotor electrical time constant; a direct-on-line start has real torque pulsations this does not show',
    ];
  return [];
}
