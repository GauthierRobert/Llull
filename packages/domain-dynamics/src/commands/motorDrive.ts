/** set_motor_drive: how a datasheet motor is commanded (dc: voltage, torque, velocity, position, prescribed; pmsm: torque, velocity, position, prescribed; stepper: step position / rate; induction: supply voltage and frequency). */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, codedRejection, failer } from '@core/commands/noop';
import { compileProfile, isAngularUnit, isProfileRefusal } from '@core/geometry/motionProfile';
import { DRIVE_MODES_BY_KIND, type DatasheetMotor, type MotorDrive } from '@core/model/drives';
import { isDatasheetMotor } from '../sim/actuators/machine';
import { MAX_BANDWIDTH_PER_RATE } from '../sim/actuators/controller';
import { buildSimulationModel, jointInertiaOf } from '../sim/simulationModel';
import { dynamicsOf, withDynamics } from './bodies';

const REMEDIATION: Readonly<Record<string, string>> = {
  DRV_PROFILE_INVALID:
    'Create the profile with add_motion_profile (voltage V, torque N*m, velocity or position in angular units) and name it in `profile`.',
  DRV_CONTROL_RATE:
    'Give sampleHz so that the controller period is a whole number of simulation steps and omega_c * T_s <= 0.2 (sampleHz >= 5 * omega_c / 1 rad).',
  DRV_TUNE_NO_INERTIA: 'Add rigid bodies with mass on the driven joint (add_rigid_body), or give explicit `gains` instead of `tune`.',
  DRV_JOINT_INVALID: 'Use a revolute joint of the model as `target`.',
  DRV_MOTOR_KIND_UNSUPPORTED:
    'Only datasheet motors (add_motor kind "dc", "pmsm", "stepper" or "induction") take a drive; torque_curve and speed motors are set by add_motor.',
  DRV_MODE_UNSUPPORTED:
    'dc: voltage, torque, velocity, position, prescribed. pmsm: torque, velocity, position, prescribed (it is torque-commanded, there is no terminal voltage to give). stepper: position, velocity (open-loop step command). induction: voltage (volts + frequencyHz), frequency (V/f profile).',
};

/** Fields of set_motor_drive that a motor kind has no use for: giving one is refused rather than silently ignored. */
const NOT_APPLICABLE: Readonly<Record<DatasheetMotor['kind'], readonly (keyof MotorDriveParams)[]>> = {
  dc: ['frequencyHz', 'stepDivision'],
  pmsm: ['volts', 'frequencyHz', 'stepDivision'],
  stepper: ['volts', 'frequencyHz', 'busVoltageV', 'sampleHz', 'gains', 'tune', 'feedforward', 'effortLimit', 'target'],
  induction: ['currentLimitA', 'busVoltageV', 'sampleHz', 'gains', 'tune', 'feedforward', 'effortLimit', 'target', 'stepDivision'],
};

interface MotorDriveParams {
  volts?: number | undefined;
  frequencyHz?: number | undefined;
  stepDivision?: number | undefined;
  currentLimitA?: number | undefined;
  busVoltageV?: number | undefined;
  sampleHz?: number | undefined;
  gains?: unknown;
  tune?: unknown;
  feedforward?: boolean | undefined;
  effortLimit?: number | undefined;
  target?: string | undefined;
}

const QUANTITY: Readonly<Record<MotorDrive['mode'], readonly string[]>> = {
  voltage: ['voltage'],
  torque: ['torque'],
  velocity: ['velocity'],
  position: ['position'],
  prescribed: ['position', 'velocity'],
  frequency: ['frequency'],
};

/**
 * @affects sets doc.dynamics.drives[motor] (affected: [motorId])
 * @invariant the drive's profile exists, compiles and has the quantity the mode needs; the mode is one the motor kind takes (DRIVE_MODES_BY_KIND); a closed loop (dc / pmsm velocity, position)
 *   has gains or a tuning, a sample rate and ω_c·T_s <= 0.2; an induction voltage drive has volts or a profile and frequencyHz; fields a kind does not use are refused
 * @failure unknown motor -> no-op; not a datasheet motor -> DRV_MOTOR_KIND_UNSUPPORTED; mode the kind does not take -> DRV_MODE_UNSUPPORTED; a field the kind does not use -> no-op; missing / wrong profile -> DRV_PROFILE_INVALID; bad sample rate or bandwidth
 *   -> DRV_CONTROL_RATE; tune without inertia on the joint -> DRV_TUNE_NO_INERTIA; unknown / non-revolute target -> DRV_JOINT_INVALID
 * @invariant kernel-optional: the tuning inertia reads body mass properties through the kernel when present, mesh integration otherwise
 */
export const setMotorDrive = defineCommand({
  name: 'set_motor_drive',
  annotations: { kernelOptional: true, readsMeshTriangles: true },
  description:
    'Command a datasheet motor (add_motor kind "dc", "pmsm", "stepper" or "induction") for simulate_motion; replaces the motor\'s previous drive, a motor without a drive is an open circuit. ' +
    'Modes by kind: dc = voltage, torque, velocity, position, prescribed; pmsm = torque, velocity, position, prescribed (field-oriented, the torque command is cut to the voltage / current ' +
    'envelope: constant torque to the base speed, field weakening above; `currentLimitA` and `busVoltageV` override the datasheet limits); stepper = position or velocity: an OPEN-LOOP step ' +
    'command (position profile = commanded shaft position, velocity profile = step rate), `stepDivision` 1 full / 2 half / n micro steps, `currentLimitA` = the chopper setpoint; the ' +
    'rotor loses steps when the load exceeds the pull-out torque at that speed (DRV_STEPS_LOST in the run); induction = voltage (`volts` phase RMS or a voltage profile at the fixed supply ' +
    '`frequencyHz`: direct-on-line) or frequency (a frequency profile in Hz with constant V/f up to the rated frequency). A mode the kind does not take is refused (DRV_MODE_UNSUPPORTED). ' +
    'The text below is for dc and pmsm unless a kind is named. ' +
    'mode "voltage": terminal voltage `volts` (constant) or a voltage `profile`; the current follows the exact winding law (back-EMF, inductance) and is clamped ' +
    'to `currentLimitA` (default the motor peak current, else U/R). mode "torque": a torque `profile` (N*m at the motor SHAFT, before the gearhead) through an ' +
    'ideal current loop. mode "velocity" / "position": a discrete cascade controller (velocity PI, plus a position P loop for position) following a velocity / ' +
    'position `profile` of the target joint; give `gains` {kp N*m per rad/s, ki, kpPosition} or `tune` {bandwidthHz, dampingRatio} (k_p = 2*zeta*w_c*J, ' +
    'k_i = w_c^2*J on the reflected inertia J of the joint, k_p,pos = w_c/4), and `sampleHz` (the period must be a whole number of simulation steps and ' +
    'w_c*T_s <= 0.2, else DRV_CONTROL_RATE); `feedforward` adds J*accel of the profile; the integrator stops winding up when the current limit saturates ' +
    '(`busVoltageV` also limits the current by R*i + ke*w <= bus). mode "prescribed": a high-gain servo that forces the joint along a position or velocity ' +
    'profile with effort limited to `effortLimit` (default the motor peak torque at the joint): the reported effort is then the inverse dynamics of the motion ' +
    '(sizing), and a tracking error above 1 % of the move warns DRV_TRACKING_ERROR. Profiles come from add_motion_profile (velocity / position units are angular). ' +
    'Returns the motor id in affected[0].',
  params: z.object({
    motor: z.string().describe('Id of a datasheet motor (add_motor kind "dc", "pmsm", "stepper" or "induction").'),
    mode: z
      .enum(['voltage', 'torque', 'velocity', 'position', 'prescribed', 'frequency'])
      .describe(
        'How the motor is commanded; the modes each kind takes are listed in the tool description. "frequency" = induction V/f supply.',
      ),
    volts: z
      .number()
      .optional()
      .describe('voltage: constant terminal voltage in V (dc: negative reverses; induction: phase RMS voltage). Instead of `profile`.'),
    frequencyHz: z
      .number()
      .positive()
      .optional()
      .describe('induction voltage mode: the fixed supply frequency in Hz (50 or 60 for a direct-on-line start).'),
    stepDivision: z
      .number()
      .int()
      .min(1)
      .max(256)
      .optional()
      .describe('stepper: steps per full step (1 full, 2 half, n micro-stepping). Default 1.'),
    profile: z
      .string()
      .optional()
      .describe(
        'Profile id (add_motion_profile): voltage V, torque N*m, velocity, position, or the prescribed motion; frequency Hz for induction mode "frequency"; stepper: the position or step-rate profile.',
      ),
    currentLimitA: z.number().positive().optional().describe('Current limit in A. Default the motor peak current, else U/R.'),
    target: z
      .string()
      .optional()
      .describe('velocity / position / prescribed: joint the controller measures and follows. Default the motor joint.'),
    gains: z
      .object({
        kp: z.number().min(0).describe('Velocity loop proportional gain, N*m per rad/s at the joint.'),
        ki: z.number().min(0).optional().describe('Velocity loop integral gain, N*m per rad. Default 0.'),
        kpPosition: z
          .number()
          .positive()
          .optional()
          .describe('Position loop gain, rad/s per rad (required in position mode; 0 otherwise).'),
      })
      .optional()
      .describe('Explicit controller gains (instead of `tune`).'),
    tune: z
      .object({
        bandwidthHz: z.number().positive().describe('Velocity loop bandwidth f_c in Hz.'),
        dampingRatio: z.number().positive().describe('Damping ratio zeta (1 = critical).'),
      })
      .optional()
      .describe('Automatic tuning from the reflected inertia of the joint (instead of `gains`).'),
    feedforward: z
      .boolean()
      .optional()
      .describe('velocity / position: add the profile acceleration times the joint inertia (and velocity for position). Default false.'),
    busVoltageV: z.number().positive().optional().describe('Supply voltage limit in V for the current-driven modes. Default unlimited.'),
    sampleHz: z.number().positive().optional().describe('velocity / position: controller sample rate in Hz (required there).'),
    effortLimit: z
      .number()
      .positive()
      .optional()
      .describe('prescribed: largest torque in N*m at the joint. Default the motor peak torque.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const name = 'set_motor_drive';
    const fail = failer(doc, name);
    const refuse = (code: string, message: string, ids: readonly string[] = []): CommandResult =>
      codedRejection(doc, name, code, message, REMEDIATION[code] ?? '', ids);
    const dynamics = dynamicsOf(doc);
    const motor = dynamics.motors[params.motor];
    if (motor === undefined) return fail(`motor '${params.motor}' not found (add_motor first)`);
    if (!isDatasheetMotor(motor)) return refuse('DRV_MOTOR_KIND_UNSUPPORTED', `motor '${motor.id}' is a ${motor.kind} motor`, [motor.id]);
    const { mode } = params;
    if (!DRIVE_MODES_BY_KIND[motor.kind].includes(mode))
      return refuse('DRV_MODE_UNSUPPORTED', `a ${motor.kind} motor takes ${DRIVE_MODES_BY_KIND[motor.kind].join(', ')}, not '${mode}'`, [
        motor.id,
      ]);
    const unused = NOT_APPLICABLE[motor.kind].find((field) => params[field] !== undefined);
    if (unused !== undefined) return fail(`'${unused}' does not apply to a ${motor.kind} motor`);
    const closedLoop = (motor.kind === 'dc' || motor.kind === 'pmsm') && (mode === 'velocity' || mode === 'position');
    const target = params.target ?? motor.joint;
    const targetJoint = dynamics.joints[target];
    if (targetJoint === undefined || targetJoint.kind !== 'revolute')
      return refuse('DRV_JOINT_INVALID', `target joint '${target}' is missing or not revolute`, [target]);
    if (mode === 'voltage' && params.volts === undefined && params.profile === undefined)
      return fail('voltage mode needs `volts` or a voltage `profile`');
    if (mode === 'frequency' && (params.volts !== undefined || params.frequencyHz !== undefined))
      return fail('frequency mode follows a frequency profile at constant V/f: volts and frequencyHz do not apply');
    if (mode === 'voltage' && motor.kind === 'induction' && params.frequencyHz === undefined)
      return fail('induction voltage mode needs `frequencyHz` (the supply frequency)');
    if (mode === 'voltage' && params.volts !== undefined && params.profile !== undefined)
      return fail('give `volts` or `profile`, not both');
    if (mode !== 'voltage' && params.profile === undefined) return refuse('DRV_PROFILE_INVALID', `${mode} mode needs a profile`);
    if (params.profile !== undefined) {
      const profile = dynamics.profiles?.[params.profile];
      if (profile === undefined) return refuse('DRV_PROFILE_INVALID', `profile '${params.profile}' not found (add_motion_profile first)`);
      if (!QUANTITY[mode].includes(profile.quantity))
        return refuse(
          'DRV_PROFILE_INVALID',
          `${mode} mode needs a ${QUANTITY[mode].join(' or ')} profile, '${profile.id}' is ${profile.quantity}`,
        );
      if ((profile.quantity === 'position' || profile.quantity === 'velocity') && !isAngularUnit(profile.unit))
        return refuse(
          'DRV_PROFILE_INVALID',
          `profile '${profile.id}' is in '${profile.unit}'; a revolute joint needs an angular unit (rad, deg, rev, rad/s, rpm, deg/s)`,
        );
      const compiled = compileProfile(profile);
      if (isProfileRefusal(compiled)) return refuse(compiled.code, `profile '${profile.id}': ${compiled.error}`);
    }
    if (closedLoop) {
      if (params.sampleHz === undefined) return refuse('DRV_CONTROL_RATE', `${mode} mode needs sampleHz`);
      if ((params.gains === undefined) === (params.tune === undefined)) return fail('give exactly one of `gains` and `tune`');
      if (mode === 'position' && params.gains !== undefined && params.gains.kpPosition === undefined)
        return fail('position mode with explicit gains needs gains.kpPosition > 0');
      if (params.tune !== undefined) {
        const ratio = (2 * Math.PI * params.tune.bandwidthHz) / params.sampleHz;
        if (ratio > MAX_BANDWIDTH_PER_RATE)
          return refuse(
            'DRV_CONTROL_RATE',
            `omega_c * T_s = ${ratio.toPrecision(3)} exceeds ${MAX_BANDWIDTH_PER_RATE} (bandwidth ${params.tune.bandwidthHz} Hz at ${params.sampleHz} Hz)`,
          );
      }
    }
    if (params.tune !== undefined || mode === 'prescribed') {
      const built = buildSimulationModel(doc, 1e-3, ctx?.kernel ?? null);
      const inertia = 'error' in built ? undefined : jointInertiaOf(built, target);
      if (inertia === undefined || !(inertia > 0))
        return refuse(
          'DRV_TUNE_NO_INERTIA',
          `joint '${target}' has no inertia to ${mode === 'prescribed' ? 'servo' : 'tune'} against${'error' in built ? ` (${built.error})` : ''}`,
          [target],
        );
    }
    const drive: MotorDrive = {
      id: motor.id,
      mode,
      ...(params.volts === undefined ? {} : { volts: params.volts }),
      ...(params.frequencyHz === undefined ? {} : { frequencyHz: params.frequencyHz }),
      ...(params.stepDivision === undefined ? {} : { stepDivision: params.stepDivision }),
      ...(params.profile === undefined ? {} : { profile: params.profile }),
      ...(params.currentLimitA === undefined ? {} : { currentLimitA: params.currentLimitA }),
      ...(params.target === undefined ? {} : { target: params.target }),
      ...(params.gains === undefined
        ? {}
        : {
            gains: {
              kp: params.gains.kp,
              ki: params.gains.ki === undefined ? 0 : params.gains.ki,
              kpPosition: params.gains.kpPosition === undefined ? 0 : params.gains.kpPosition,
            },
          }),
      ...(params.tune === undefined ? {} : { tune: params.tune }),
      ...(params.feedforward === undefined ? {} : { feedforward: params.feedforward }),
      ...(params.busVoltageV === undefined ? {} : { busVoltageV: params.busVoltageV }),
      ...(params.sampleHz === undefined ? {} : { sampleHz: params.sampleHz }),
      ...(params.effortLimit === undefined ? {} : { effortLimit: params.effortLimit }),
    };
    const what =
      mode === 'voltage'
        ? params.volts === undefined
          ? `profile '${params.profile}'`
          : `${params.volts} V${params.frequencyHz === undefined ? '' : ` at ${params.frequencyHz} Hz`}`
        : `profile '${params.profile}'`;
    return changed(
      withDynamics(doc, { ...dynamics, drives: { ...dynamics.drives, [motor.id]: drive } }),
      `set_motor_drive: '${motor.id}' ${mode} on joint '${motor.joint}' — ${what}` +
        `${params.sampleHz === undefined ? '' : `, ${params.sampleHz} Hz`}${params.tune === undefined ? '' : `, tuned ${params.tune.bandwidthHz} Hz zeta ${params.tune.dampingRatio}`}.`,
      [motor.id],
    );
  },
});
