/**
 * The `ActuatorBlock` of a document's datasheet motors (PHY-23 TR-DRV-01): every motor that has a drive (dc, pmsm, stepper, induction) becomes one electrical +
 * controller state in `aux`, advanced once per physics step with its kind's law (`machineStep.ts`), and a per-motor energy ledger.
 */

import type { ActuatorBlock } from '@core/dynamics/physicsEngine';
import { compileProfile, isProfileRefusal, profileUnitScale } from '@core/geometry/motionProfile';
import { DRIVE_MODES_BY_KIND, type DatasheetMotor, type MotorDrive } from '@core/model/drives';
import type { DynamicsModel } from '@core/model/dynamics';
import { AUX, AUX_SIZE, MAX_BANDWIDTH_PER_RATE, tunedGains, updateLoop, type LoopGains, type LoopSpec } from './controller';
import { dcParameters } from './dcMotor';
import type { DriveRuntime, MachineRuntime, ResolvedProfile } from './driveRuntime';
import { jointTorque } from './drivetrain';
import { inductionParameters } from './induction';
import { isDatasheetMotor, ledgerKindsOf, peakJointTorque } from './machine';
import { stepMachine } from './machineStep';
import { pmsmParameters } from './pmsm';
import { stepperParameters } from './stepper';

export type { DriveRuntime } from './driveRuntime';

export interface ActuatorRefusal {
  readonly code: 'DRV_PROFILE_INVALID' | 'DRV_CONTROL_RATE' | 'DRV_TUNE_NO_INERTIA' | 'DRV_JOINT_INVALID' | 'DRV_MODE_UNSUPPORTED';
  readonly error: string;
}

export interface ActuatorBuild {
  readonly block: ActuatorBlock;
  readonly drives: readonly DriveRuntime[];
}

export interface ActuatorContext {
  readonly timestep: number;
  /** kg·m² about the joint (bodies it carries + armature), or undefined when the joint cannot move. */
  readonly inertiaOf: (joint: string) => number | undefined;
}

const MODE_QUANTITY: Readonly<Record<MotorDrive['mode'], readonly string[]>> = {
  voltage: ['voltage'],
  torque: ['torque'],
  velocity: ['velocity'],
  position: ['position'],
  prescribed: ['position', 'velocity'],
  frequency: ['frequency'],
};

const refusal = (code: ActuatorRefusal['code'], error: string): ActuatorRefusal => ({ code, error });
const isRefusal = (value: unknown): value is ActuatorRefusal =>
  typeof value === 'object' && value !== null && 'code' in value && 'error' in value;

function resolveProfile(dynamics: DynamicsModel, drive: MotorDrive): ResolvedProfile | null | ActuatorRefusal {
  if (drive.profile === undefined) return null;
  const stored = dynamics.profiles?.[drive.profile];
  if (stored === undefined) return refusal('DRV_PROFILE_INVALID', `drive of '${drive.id}': profile '${drive.profile}' not found`);
  if (!MODE_QUANTITY[drive.mode].includes(stored.quantity))
    return refusal(
      'DRV_PROFILE_INVALID',
      `drive of '${drive.id}' (${drive.mode}) needs a ${MODE_QUANTITY[drive.mode].join(' or ')} profile, '${stored.id}' is ${stored.quantity}`,
    );
  const compiled = compileProfile(stored);
  if (isProfileRefusal(compiled)) return refusal('DRV_PROFILE_INVALID', `profile '${stored.id}': ${compiled.code} — ${compiled.error}`);
  const scale = profileUnitScale(stored.quantity, stored.unit);
  if (scale === null)
    return refusal('DRV_PROFILE_INVALID', `profile '${stored.id}': unit '${stored.unit}' is not a ${stored.quantity} unit`);
  return { profile: compiled, scale, quantity: stored.quantity };
}

/** The controller of a velocity / position / prescribed drive, or why it cannot run at `context.timestep`. */
function loopOf(
  drive: MotorDrive,
  peakTorque: number,
  context: ActuatorContext,
  resolved: ResolvedProfile,
  inertia: number,
): LoopSpec | ActuatorRefusal {
  const mode = drive.mode as LoopSpec['mode'];
  const hz = drive.sampleHz;
  let gains: LoopGains | null = drive.gains ?? null;
  if (drive.tune !== undefined) {
    if (!(inertia > 0)) return refusal('DRV_TUNE_NO_INERTIA', `tuning '${drive.id}' needs bodies with mass on the driven joint`);
    gains = tunedGains(inertia, drive.tune.bandwidthHz, drive.tune.dampingRatio);
    if (hz !== undefined && (2 * Math.PI * drive.tune.bandwidthHz) / hz > MAX_BANDWIDTH_PER_RATE)
      return refusal(
        'DRV_CONTROL_RATE',
        `ω_c·T_s = ${((2 * Math.PI * drive.tune.bandwidthHz) / hz).toPrecision(3)} exceeds ${MAX_BANDWIDTH_PER_RATE}: raise sampleHz or lower the bandwidth`,
      );
  }
  let period = 1;
  if (mode !== 'prescribed') {
    if (hz === undefined) return refusal('DRV_CONTROL_RATE', `drive of '${drive.id}' (${mode}) needs sampleHz`);
    period = Math.round(1 / (hz * context.timestep));
    if (period < 1 || Math.abs(period * context.timestep * hz - 1) > 1e-6)
      return refusal(
        'DRV_CONTROL_RATE',
        `sampleHz ${hz} is not a whole number of ${context.timestep} s steps (the controller period must be k·Δt)`,
      );
    if (gains === null) return refusal('DRV_TUNE_NO_INERTIA', `drive of '${drive.id}' needs gains or tune`);
    if (mode === 'position' && !(gains.kpPosition > 0))
      return refusal('DRV_TUNE_NO_INERTIA', `position drive of '${drive.id}' needs gains.kpPosition or tune`);
  } else if (!(inertia > 0))
    return refusal('DRV_TUNE_NO_INERTIA', `prescribed drive of '${drive.id}' needs bodies with mass on the driven joint`);
  return {
    mode,
    profile: resolved.profile,
    scale: resolved.scale,
    quantity: resolved.quantity === 'position' ? 'position' : 'velocity',
    gains: gains === null ? { kp: 0, ki: 0, kpPosition: 0 } : gains,
    feedforward: drive.feedforward === true,
    inertia,
    periodSteps: period,
    torqueLimit: drive.effortLimit === undefined ? peakTorque : drive.effortLimit,
  };
}

/** The kind's electrical law with this drive's limits, or why the drive cannot run on it. */
function machineOf(motor: DatasheetMotor, drive: MotorDrive): MachineRuntime | ActuatorRefusal {
  switch (motor.kind) {
    case 'dc':
      return { kind: 'dc', params: dcParameters(motor) };
    case 'pmsm': {
      const params = pmsmParameters(motor);
      return {
        kind: 'pmsm',
        params,
        limits: {
          currentA: drive.currentLimitA === undefined ? params.currentLimitA : drive.currentLimitA,
          busVoltageV: drive.busVoltageV === undefined ? params.busVoltageV : drive.busVoltageV,
        },
      };
    }
    case 'stepper': {
      const params = stepperParameters(motor);
      return {
        kind: 'stepper',
        params,
        division: drive.stepDivision === undefined ? 1 : drive.stepDivision,
        setCurrentA: drive.currentLimitA === undefined ? params.ratedCurrentA : drive.currentLimitA,
      };
    }
    case 'induction': {
      if (drive.mode === 'voltage' && !(drive.frequencyHz !== undefined && drive.frequencyHz > 0))
        return refusal(
          'DRV_PROFILE_INVALID',
          `drive of '${motor.id}' (voltage on an induction motor) needs frequencyHz > 0 (the supply frequency)`,
        );
      return {
        kind: 'induction',
        params: inductionParameters(motor),
        frequencyHz: drive.mode === 'voltage' ? (drive.frequencyHz ?? null) : null,
      };
    }
  }
}

/** Runtimes of the document's driven datasheet motors, or why not. */
function runtimes(dynamics: DynamicsModel, context: ActuatorContext): DriveRuntime[] | ActuatorRefusal {
  const out: DriveRuntime[] = [];
  let ledgerBase = 0;
  for (const motor of Object.values(dynamics.motors)) {
    const drive = dynamics.drives?.[motor.id];
    if (!isDatasheetMotor(motor) || drive === undefined) continue;
    if (!DRIVE_MODES_BY_KIND[motor.kind].includes(drive.mode))
      return refusal(
        'DRV_MODE_UNSUPPORTED',
        `drive of '${motor.id}': a ${motor.kind} motor takes ${DRIVE_MODES_BY_KIND[motor.kind].join(', ')}, not '${drive.mode}'`,
      );
    const machine = machineOf(motor, drive);
    if (isRefusal(machine)) return machine;
    const target = drive.target === undefined ? motor.joint : drive.target;
    const inertia = context.inertiaOf(target);
    if (inertia === undefined) return refusal('DRV_JOINT_INVALID', `drive of '${motor.id}' measures joint '${target}', which cannot move`);
    const resolved = resolveProfile(dynamics, drive);
    if (isRefusal(resolved)) return resolved;
    if (resolved === null && drive.mode !== 'voltage')
      return refusal('DRV_PROFILE_INVALID', `drive of '${motor.id}' (${drive.mode}) needs a profile`);
    if (resolved === null && drive.volts === undefined)
      return refusal('DRV_PROFILE_INVALID', `drive of '${motor.id}' (voltage) needs volts or a profile`);
    const closed =
      (drive.mode === 'velocity' || drive.mode === 'position' || drive.mode === 'prescribed') &&
      (motor.kind === 'dc' || motor.kind === 'pmsm');
    const loop =
      closed && resolved !== null ? loopOf(drive, peakJointTorque(motor, drive.currentLimitA), context, resolved, inertia) : null;
    if (isRefusal(loop)) return loop;
    out.push({
      motor,
      drive,
      machine,
      params: machine.params,
      base: out.length * AUX_SIZE,
      ledgerBase,
      target,
      currentLimitA: drive.currentLimitA === undefined ? machine.params.currentLimitA : drive.currentLimitA,
      busVoltageV: machine.kind === 'pmsm' ? machine.limits.busVoltageV : drive.busVoltageV === undefined ? Infinity : drive.busVoltageV,
      constantVolts: drive.volts === undefined ? 0 : drive.volts,
      resolved,
      loop,
    });
    ledgerBase += ledgerKindsOf(motor.kind).length;
  }
  return out;
}

/** The actuator block of the document at step `timestep`, null when no motor is driven, or the reason it cannot be built. */
export function buildActuators(dynamics: DynamicsModel, context: ActuatorContext): ActuatorBuild | null | ActuatorRefusal {
  const drives = runtimes(dynamics, context);
  if (isRefusal(drives)) return drives;
  if (drives.length === 0) return null;
  const joints = [...new Set(drives.map((run) => run.motor.joint))];
  const ledgerSize = drives.reduce((sum, run) => sum + ledgerKindsOf(run.motor.kind).length, 0);
  const aux0 = new Float64Array(drives.length * AUX_SIZE);
  for (const run of drives) if (run.machine.kind === 'stepper') aux0[run.base + AUX.lostTime] = -1;
  const block: ActuatorBlock = {
    size: drives.length * AUX_SIZE,
    aux0,
    joints,
    ledgerLayout: drives.flatMap((run) => ledgerKindsOf(run.motor.kind).map((kind) => ({ element: run.motor.id, kind }))),
    advance: (state, previous, dt) => {
      const aux = previous.slice();
      const jointForces = new Float64Array(joints.length);
      const ledger = new Float64Array(ledgerSize);
      for (const run of drives) {
        const { params, base } = run;
        const omegaMotor = params.gearRatio * (state.jointVelocity[run.motor.joint] ?? Number.NaN);
        const thetaMotor = params.gearRatio * (state.jointPosition[run.motor.joint] ?? Number.NaN);
        if (run.loop !== null) {
          const position = state.jointPosition[run.target];
          const velocity = state.jointVelocity[run.target];
          if (position !== undefined && velocity !== undefined) updateLoop(run.loop, aux, base, state.time, position, velocity, dt);
        }
        const step = stepMachine({ run, time: state.time, omegaMotor, thetaMotor, aux, dt });
        const joint = jointTorque(params, step.shaftTorque, omegaMotor, dt);
        const electrical = step.powerW * dt;
        const slot = joints.indexOf(run.motor.joint);
        jointForces[slot] = (jointForces[slot] ?? 0) + joint.torque;
        aux[base + AUX.current] = step.current;
        aux[base + AUX.voltage] = step.volts;
        aux[base + AUX.meanCurrent] = step.meanCurrent;
        aux[base + AUX.shaftTorque] = step.shaftTorque;
        aux[base + AUX.jointTorque] = joint.torque;
        aux[base + AUX.limited] = step.limited;
        aux[base + AUX.clipped] = step.clipped;
        aux[base + AUX.power] = step.powerW;
        aux[base + AUX.steps] = (aux[base + AUX.steps] ?? 0) + 1;
        ledger[run.ledgerBase] = electrical;
        ledger[run.ledgerBase + 1] = step.copperJ;
        ledger[run.ledgerBase + 2] = step.magneticJ;
        ledger[run.ledgerBase + 3] = joint.gearLossJ;
        ledger[run.ledgerBase + 4] = Math.min(electrical, 0);
        step.extraJ.forEach((joules, k) => {
          ledger[run.ledgerBase + 5 + k] = joules;
        });
      }
      return { aux, jointForces, bodyForces: [], ledger };
    },
  };
  return { block, drives };
}
