/**
 * One physics step of a driven datasheet motor, by kind (PHY-23 TR-DRV-05..08): the electrical law maps the command (voltage, torque, step profile, supply)
 * and the midpoint shaft state to the torque on the motor shaft, the electrical power and the losses of the step. The caller turns the shaft torque into
 * a joint torque through the gearhead and records the slots; stepper state (field angle, lag, lost steps) lives in `aux`.
 */

import { elementAt } from '@lib/elementAt';
import { AUX } from './controller';
import { electricalStep } from './dcMotor';
import type { DriveRuntime } from './driveRuntime';
import { shaftTorqueFor } from './drivetrain';
import { inductionPoint, voltsPerHertz } from './induction';
import { pmsmOperatingPoint } from './pmsm';
import { periodsLost, stepperTorque } from './stepper';

export interface StepInput {
  readonly run: DriveRuntime;
  readonly time: number;
  /** Motor-shaft speed (gear ratio × joint speed), rad/s. */
  readonly omegaMotor: number;
  /** Motor-shaft angle (gear ratio × joint position), rad. */
  readonly thetaMotor: number;
  /** The actuator state copy of this step: the step reads and writes the slots of its motor. */
  readonly aux: Float64Array;
  readonly dt: number;
}

export interface StepOutcome {
  /** Terminal / phase voltage of the record, V. */
  readonly volts: number;
  /** Current recorded at the end of the step (the winding state of a dc motor), A. */
  readonly current: number;
  readonly meanCurrent: number;
  /** N·m applied at the motor shaft over the step. */
  readonly shaftTorque: number;
  readonly powerW: number;
  readonly copperJ: number;
  readonly magneticJ: number;
  /** Entries after the shared five of `ledgerKindsOf(kind)` (stepper: rotor; induction: iron, rotor), J. */
  readonly extraJ: readonly number[];
  readonly limited: number;
  readonly clipped: number;
}

/** Value of the drive's profile at `time` in SI units (0 without a profile). */
function profileValue(run: DriveRuntime, time: number): number {
  return run.resolved === null ? 0 : run.resolved.profile.evaluate(time).value * run.resolved.scale;
}

/** Terminal voltage commanded by a voltage-mode drive at `time`. */
const commandedVolts = (run: DriveRuntime, time: number): number => (run.resolved === null ? run.constantVolts : profileValue(run, time));

/** Shaft torque a torque-mode drive commands at `time`, or the torque the loop holds (joint torque held, back through the gearhead). */
function wantedShaftTorque(input: StepInput): number {
  const { run, aux } = input;
  if (run.drive.mode === 'torque') return profileValue(run, input.time);
  const held = aux[run.base + AUX.heldTorque];
  return shaftTorqueFor(run.params, held === undefined ? 0 : held, input.omegaMotor);
}

const slot = (aux: Float64Array, run: DriveRuntime, offset: number): number => elementAt(aux, run.base + offset);

/** True when the closed loop's command sits at its torque limit (anti-windup flag of the current-driven kinds). */
function loopSaturated(input: StepInput): boolean {
  const { run, aux } = input;
  return run.loop !== null && Math.abs(slot(aux, run, AUX.heldTorque)) >= run.loop.torqueLimit * (1 - 1e-12);
}

function stepDc(input: StepInput, params: Extract<DriveRuntime['machine'], { kind: 'dc' }>['params']): StepOutcome {
  const { run, time, omegaMotor, aux, dt } = input;
  const ke = params.torqueConstant;
  let volts = 0;
  let limited = 0;
  let clipped = 0;
  let step;
  if (run.drive.mode === 'voltage') {
    volts = commandedVolts(run, time);
    const steady = (volts - ke * omegaMotor) / params.resistanceOhm;
    if (Math.abs(steady) > run.currentLimitA) {
      volts = ke * omegaMotor + params.resistanceOhm * Math.sign(steady) * run.currentLimitA;
      limited = 1;
    }
    step = electricalStep(params, volts, omegaMotor, slot(aux, run, AUX.current), dt);
  } else {
    const wanted = wantedShaftTorque(input) / ke;
    const upper = Math.min(run.currentLimitA, (run.busVoltageV - ke * omegaMotor) / params.resistanceOhm);
    const lower = Math.max(-run.currentLimitA, (-run.busVoltageV - ke * omegaMotor) / params.resistanceOhm);
    const current = Math.min(upper, Math.max(lower, wanted));
    clipped = current === wanted ? 0 : 1;
    limited = clipped === 0 && !loopSaturated(input) ? 0 : 1;
    volts = params.resistanceOhm * current + ke * omegaMotor;
    step = { current, meanCurrent: current, copperJ: params.resistanceOhm * current * current * dt, magneticJ: 0 };
  }
  return {
    volts,
    current: step.current,
    meanCurrent: step.meanCurrent,
    shaftTorque: ke * step.meanCurrent,
    powerW: volts * step.meanCurrent,
    copperJ: step.copperJ,
    magneticJ: step.magneticJ,
    extraJ: [],
    limited,
    clipped,
  };
}

function stepPmsm(input: StepInput, machine: Extract<DriveRuntime['machine'], { kind: 'pmsm' }>): StepOutcome {
  const point = pmsmOperatingPoint(machine.params, machine.limits, wantedShaftTorque(input), input.omegaMotor);
  const clipped = point.clipped ? 1 : 0;
  return {
    volts: point.voltageV,
    current: point.currentA,
    meanCurrent: point.currentA,
    shaftTorque: point.torqueNm,
    powerW: point.powerW,
    copperJ: point.copperW * input.dt,
    magneticJ: 0,
    extraJ: [],
    limited: clipped === 0 && !loopSaturated(input) ? 0 : 1,
    clipped,
  };
}

/** Supply of an induction drive at `time`: phase voltage (V RMS) and frequency (Hz, signed). */
function inductionSupply(input: StepInput, machine: Extract<DriveRuntime['machine'], { kind: 'induction' }>): [number, number] {
  const { run, time } = input;
  if (run.drive.mode === 'frequency') {
    const frequency = profileValue(run, time);
    return [voltsPerHertz(machine.params, frequency), frequency];
  }
  return [commandedVolts(run, time), machine.frequencyHz === null ? Number.NaN : machine.frequencyHz];
}

function stepInduction(input: StepInput, machine: Extract<DriveRuntime['machine'], { kind: 'induction' }>): StepOutcome {
  const [volts, frequency] = inductionSupply(input, machine);
  const point = inductionPoint(machine.params, volts, frequency, input.omegaMotor);
  input.aux[input.run.base + AUX.frequency] = frequency;
  return {
    volts,
    current: point.currentA,
    meanCurrent: point.currentA,
    shaftTorque: point.torqueNm,
    powerW: point.powerW,
    copperJ: point.statorCopperW * input.dt,
    magneticJ: 0,
    extraJ: [point.ironW * input.dt, point.rotorCopperW * input.dt],
    limited: 0,
    clipped: 0,
  };
}

/** Quantise `angle` to a multiple of `increment`. */
const quantised = (angle: number, increment: number): number => Math.round(angle / increment) * increment;

function stepStepper(input: StepInput, machine: Extract<DriveRuntime['machine'], { kind: 'stepper' }>): StepOutcome {
  const { run, time, omegaMotor, thetaMotor, aux, dt } = input;
  const { params } = machine;
  const reference = profileValue(run, time);
  const first = slot(aux, run, AUX.steps) === 0;
  // position profile: the commanded motor angle; velocity profile: the integral of the commanded step rate (midpoint rule)
  const previous = slot(aux, run, AUX.command);
  const commanded = run.drive.mode === 'position' ? params.gearRatio * reference : previous + params.gearRatio * reference * dt;
  const increment = (2 * Math.PI) / (params.stepsPerRev * machine.division);
  if (first) aux[run.base + AUX.offset] = thetaMotor - quantised(commanded, increment);
  const field = slot(aux, run, AUX.offset) + quantised(commanded, increment);
  const scale = machine.setCurrentA / params.ratedCurrentA;
  const torque = stepperTorque(params, thetaMotor, field, omegaMotor, scale);
  const active = torque.fieldNm + torque.detentNm;
  const lost = 4 * periodsLost(torque.lagRad);
  aux[run.base + AUX.command] = commanded;
  aux[run.base + AUX.lag] = torque.lagRad;
  aux[run.base + AUX.lostSteps] = lost;
  if (lost !== 0 && slot(aux, run, AUX.lostTime) < 0) aux[run.base + AUX.lostTime] = time;
  const copperW = 2 * params.resistanceOhm * machine.setCurrentA * machine.setCurrentA;
  return {
    volts: params.resistanceOhm * machine.setCurrentA,
    current: machine.setCurrentA,
    meanCurrent: machine.setCurrentA,
    shaftTorque: active + torque.dampingNm,
    // the field's stored energy is not tracked: the electrical input is the copper loss plus the work of the energised field and the detent
    powerW: copperW + active * omegaMotor,
    copperJ: copperW * dt,
    magneticJ: 0,
    extraJ: [params.dampingNmsPerRad * omegaMotor * omegaMotor * dt],
    limited: 0,
    clipped: 0,
  };
}

/** The step of the motor of `input.run`, by its kind. */
export function stepMachine(input: StepInput): StepOutcome {
  const { machine } = input.run;
  switch (machine.kind) {
    case 'dc':
      return stepDc(input, machine.params);
    case 'pmsm':
      return stepPmsm(input, machine);
    case 'induction':
      return stepInduction(input, machine);
    case 'stepper':
      return stepStepper(input, machine);
  }
}
