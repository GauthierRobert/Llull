// Presentation of the motors, drives and motion profiles of `dynamics` (PHY-23) for Mechanisms › Physics, and the structural reading of the
// energy ledger a run returns. Pure. Every switch over a union is exhaustive (no default): a new motor kind or segment kind fails the typecheck
// here instead of rendering nothing.

import type { Motor } from '@core/model/dynamics';
import type {
  DcMotor,
  Gearhead,
  InductionMotor,
  MotionProfile,
  MotorDrive,
  ParameterSource,
  PmsmMotor,
  ProfileSegment,
  StepperMotor,
} from '@core/model/drives';
import { formatQuantity } from '@dynamics/index';

export interface Fact {
  readonly label: string;
  readonly value: string;
}

const q = (value: number): string => formatQuantity(value);
const fact = (label: string, value: string): Fact => ({ label, value });
const present = (label: string, value: number | undefined, unit: string): Fact[] =>
  value === undefined ? [] : [fact(label, `${q(value)} ${unit}`)];
const sourceFact = (source: ParameterSource): Fact => fact('Source', `${source.name} (grade ${source.grade})`);

function motorKindLabel(motor: Motor): string {
  switch (motor.kind) {
    case 'torque_curve':
      return 'torque curve';
    case 'speed':
      return 'speed governor';
    case 'linear_speed':
      return 'linear speed governor';
    case 'dc':
      return 'datasheet DC motor';
    case 'pmsm':
      return 'datasheet PMSM / BLDC motor (field-oriented)';
    case 'stepper':
      return 'datasheet hybrid stepper';
    case 'induction':
      return 'datasheet induction motor';
  }
}

const gearheadFacts = (gearhead: Gearhead | undefined): Fact[] =>
  gearhead === undefined
    ? []
    : [
        fact(
          'Gearhead',
          `${q(gearhead.ratio)}:1, efficiency ${q(gearhead.efficiency)}${gearhead.efficiencyBack === undefined ? '' : ` (back ${q(gearhead.efficiencyBack)})`}`,
        ),
      ];

const trustFacts = (motor: { readonly source: ParameterSource; readonly acceptInconsistent?: string }): Fact[] => [
  sourceFact(motor.source),
  ...(motor.acceptInconsistent === undefined
    ? []
    : [fact('Unverified', `datasheet accepted as inconsistent: ${motor.acceptInconsistent}`)]),
];

function pmsmFacts(motor: PmsmMotor): Fact[] {
  const sheet = motor.datasheet;
  return [
    fact('Pole pairs', String(sheet.polePairs)),
    fact('Phase resistance', `${q(sheet.phaseResistanceOhm)} Ω`),
    fact('Phase inductance', `${q(sheet.inductanceH)} H`),
    ...present('Flux linkage', sheet.fluxLinkageWb, 'Wb'),
    ...present('Torque constant Kt', sheet.torqueConstantNmPerA, 'N·m/A'),
    fact('Rotor inertia', `${q(sheet.rotorInertiaKgM2)} kg·m²`),
    fact('Bus voltage', `${q(sheet.busVoltageV)} V`),
    fact('Peak current', `${q(sheet.peakCurrentA)} A`),
    ...present('Nominal current', sheet.nominalCurrentA, 'A'),
    ...present('Max speed', sheet.maxSpeedRpm, 'rpm'),
    ...present('Rotor friction', sheet.frictionNm, 'N·m'),
    ...gearheadFacts(motor.gearhead),
    ...trustFacts(motor),
  ];
}

function stepperFacts(motor: StepperMotor): Fact[] {
  const sheet = motor.datasheet;
  return [
    fact('Steps per revolution', String(sheet.stepsPerRev)),
    fact('Holding torque', `${q(sheet.holdingTorqueNm)} N·m`),
    fact('Rated current', `${q(sheet.ratedCurrentA)} A per phase`),
    fact('Phase resistance', `${q(sheet.phaseResistanceOhm)} Ω`),
    fact('Phase inductance', `${q(sheet.phaseInductanceH)} H`),
    fact('Rotor inertia', `${q(sheet.rotorInertiaKgM2)} kg·m²`),
    ...present('Detent torque', sheet.detentTorqueNm, 'N·m'),
    fact('Pull-out torque', sheet.pullOutCurve === undefined ? 'L/R roll-off' : `datasheet curve, ${sheet.pullOutCurve.length} points`),
    ...present('Damping', sheet.dampingNmsPerRad, 'N·m·s/rad'),
    ...present('Max speed', sheet.maxSpeedRpm, 'rpm'),
    ...gearheadFacts(motor.gearhead),
    ...trustFacts(motor),
  ];
}

function inductionFacts(motor: InductionMotor): Fact[] {
  const sheet = motor.datasheet;
  return [
    fact('Pole pairs', String(sheet.polePairs)),
    fact('Rated supply', `${q(sheet.ratedVoltageV)} V per phase, ${q(sheet.ratedFrequencyHz)} Hz`),
    fact('Stator R1 / X1', `${q(sheet.statorResistanceOhm)} Ω / ${q(sheet.statorLeakageReactanceOhm)} Ω`),
    fact('Rotor R2 / X2 (referred)', `${q(sheet.rotorResistanceOhm)} Ω / ${q(sheet.rotorLeakageReactanceOhm)} Ω`),
    fact('Magnetising Xm', `${q(sheet.magnetisingReactanceOhm)} Ω`),
    ...present('Iron-loss Rc', sheet.ironLossResistanceOhm, 'Ω'),
    fact('Rotor inertia', `${q(sheet.rotorInertiaKgM2)} kg·m²`),
    ...present('Rated load current', sheet.nominalCurrentA, 'A'),
    ...present('Breakdown torque (sheet)', sheet.breakdownTorqueNm, 'N·m'),
    ...present('Max speed', sheet.maxSpeedRpm, 'rpm'),
    ...gearheadFacts(motor.gearhead),
    ...trustFacts(motor),
  ];
}

function dcFacts(motor: DcMotor): Fact[] {
  const sheet = motor.datasheet;
  const gearhead = motor.gearhead;
  return [
    fact('Rated voltage', `${q(sheet.nominalVoltageV)} V`),
    fact('Terminal resistance', `${q(sheet.terminalResistanceOhm)} Ω`),
    ...present('Terminal inductance', sheet.terminalInductanceH, 'H'),
    fact('Torque constant kt', `${q(sheet.torqueConstantNmPerA)} N·m/A`),
    ...present('Speed constant kv', sheet.speedConstantRpmPerV, 'rpm/V'),
    fact('Rotor inertia', `${q(sheet.rotorInertiaKgM2)} kg·m²`),
    ...present('No-load current', sheet.noLoadCurrentA, 'A'),
    ...present('No-load speed', sheet.noLoadSpeedRpm, 'rpm'),
    ...present('Stall torque', sheet.stallTorqueNm, 'N·m'),
    ...present('Stall current', sheet.stallCurrentA, 'A'),
    ...present('Nominal current', sheet.nominalCurrentA, 'A'),
    ...present('Peak current', sheet.peakCurrentA, 'A'),
    ...present('Max speed', sheet.maxSpeedRpm, 'rpm'),
    ...(gearhead === undefined
      ? []
      : [
          fact(
            'Gearhead',
            `${q(gearhead.ratio)}:1, efficiency ${q(gearhead.efficiency)}${gearhead.efficiencyBack === undefined ? '' : ` (back ${q(gearhead.efficiencyBack)})`}`,
          ),
        ]),
    sourceFact(motor.source),
    ...(motor.acceptInconsistent === undefined
      ? []
      : [fact('Unverified', `datasheet accepted as inconsistent: ${motor.acceptInconsistent}`)]),
  ];
}

/** The stored parameters of a motor, as label / value rows. */
export function motorFacts(motor: Motor): Fact[] {
  return [fact('Kind', motorKindLabel(motor)), ...kindFacts(motor)];
}

function kindFacts(motor: Motor): Fact[] {
  switch (motor.kind) {
    case 'torque_curve': {
      const rpms = motor.curve.map((point) => point[0]);
      const peak = motor.curve.reduce((best, point) => (point[1] > best[1] ? point : best), motor.curve[0] ?? [0, 0]);
      return [
        fact('Curve', `${motor.curve.length} points, ${q(Math.min(...rpms))}–${q(Math.max(...rpms))} rpm`),
        fact('Peak torque', `${q(peak[1])} N·m at ${q(peak[0])} rpm`),
        fact('Throttle', `${q(motor.throttle * 100)} %`),
      ];
    }
    case 'speed':
      return [
        fact('Held speed', `${q(motor.rpm)} rpm`),
        fact('Torque bound', `${q(motor.maxTorque)} N·m`),
        motor.source === undefined ? fact('Source', 'none: the bound is a guess') : sourceFact(motor.source),
      ];
    case 'linear_speed':
      return [
        fact('Held speed', `${q(motor.speedMps)} m/s`),
        fact('Force bound', `${q(motor.maxForceN)} N`),
        motor.source === undefined ? fact('Source', 'none: the bound is a guess') : sourceFact(motor.source),
      ];
    case 'dc':
      return dcFacts(motor);
    case 'pmsm':
      return pmsmFacts(motor);
    case 'stepper':
      return stepperFacts(motor);
    case 'induction':
      return inductionFacts(motor);
  }
}

const gearSuffix = (gearhead: Gearhead | undefined): string => (gearhead === undefined ? '' : ` · ${q(gearhead.ratio)}:1`);

/** Short headline of a motor row (the kind, then its key figures). */
export function motorHeadline(motor: Motor): string {
  switch (motor.kind) {
    case 'torque_curve':
      return `curve · ${motor.curve.length} pt`;
    case 'speed':
      return `governor · ${q(motor.rpm)} rpm ≤ ${q(motor.maxTorque)} N·m`;
    case 'linear_speed':
      return `governor · ${q(motor.speedMps)} m/s ≤ ${q(motor.maxForceN)} N`;
    case 'dc':
      return `DC · ${q(motor.datasheet.nominalVoltageV)} V${gearSuffix(motor.gearhead)}`;
    case 'pmsm':
      return `PMSM · ${q(motor.datasheet.busVoltageV)} V bus · ${q(motor.datasheet.peakCurrentA)} A${gearSuffix(motor.gearhead)}`;
    case 'stepper':
      return `stepper · ${motor.datasheet.stepsPerRev} steps · ${q(motor.datasheet.holdingTorqueNm)} N·m holding${gearSuffix(motor.gearhead)}`;
    case 'induction':
      return `induction · ${q(motor.datasheet.ratedVoltageV)} V / ${q(motor.datasheet.ratedFrequencyHz)} Hz${gearSuffix(motor.gearhead)}`;
  }
}

function driveModeLabel(mode: MotorDrive['mode']): string {
  switch (mode) {
    case 'voltage':
      return 'voltage';
    case 'torque':
      return 'torque profile';
    case 'velocity':
      return 'velocity loop';
    case 'position':
      return 'position loop';
    case 'prescribed':
      return 'prescribed motion';
    case 'frequency':
      return 'V/f supply';
  }
}

/** The drive of a motor as label / value rows (mode, command, limits, controller). */
export function driveFacts(drive: MotorDrive): Fact[] {
  return [
    fact('Mode', driveModeLabel(drive.mode)),
    ...(drive.volts === undefined ? [] : [fact('Terminal voltage', `${q(drive.volts)} V`)]),
    ...present('Supply frequency', drive.frequencyHz, 'Hz'),
    ...(drive.stepDivision === undefined ? [] : [fact('Step division', `1/${drive.stepDivision}`)]),
    ...(drive.profile === undefined ? [] : [fact('Profile', drive.profile)]),
    ...present('Current limit', drive.currentLimitA, 'A'),
    ...present('Bus voltage', drive.busVoltageV, 'V'),
    ...present('Effort limit', drive.effortLimit, 'N·m'),
    ...(drive.target === undefined ? [] : [fact('Follows joint', drive.target)]),
    ...(drive.tune === undefined ? [] : [fact('Tuning', `${q(drive.tune.bandwidthHz)} Hz, damping ${q(drive.tune.dampingRatio)}`)]),
    ...(drive.gains === undefined
      ? []
      : [fact('Gains', `kp ${q(drive.gains.kp)}, ki ${q(drive.gains.ki)}, kpPosition ${q(drive.gains.kpPosition)}`)]),
    ...present('Sample rate', drive.sampleHz, 'Hz'),
    ...(drive.feedforward === true ? [fact('Feedforward', 'on')] : []),
  ];
}

/** One-line name of a drive: its mode and profile, for the note before it is replaced. */
export function driveHeadline(drive: MotorDrive): string {
  return `${driveModeLabel(drive.mode)} drive${drive.profile === undefined ? '' : ` (profile ${drive.profile})`}`;
}

/** Duration of a segment in s, or null when it follows from vmax / amax (known only to the compiled profile). */
function segmentSeconds(segment: ProfileSegment): number | null {
  switch (segment.kind) {
    case 'dwell':
      return segment.duration;
    case 'move':
      return segment.duration ?? null;
    case 'sine':
      return segment.cycles / segment.frequencyHz;
    case 'table':
      return segment.points[segment.points.length - 1]?.[0] ?? 0;
  }
}

function moveLimits(segment: Extract<ProfileSegment, { kind: 'move' }>): string[] {
  return [
    ...(segment.duration === undefined ? [] : [`${q(segment.duration)} s`]),
    ...(segment.vmax === undefined ? [] : [`vmax ${q(segment.vmax)}`]),
    ...(segment.amax === undefined ? [] : [`amax ${q(segment.amax)}`]),
    ...(segment.jerk === undefined ? [] : [`jerk ${q(segment.jerk)}`]),
    ...(segment.accelFraction === undefined ? [] : [`accel fraction ${q(segment.accelFraction)}`]),
  ];
}

function segmentText(segment: ProfileSegment, unit: string): string {
  switch (segment.kind) {
    case 'dwell':
      return `dwell ${q(segment.duration)} s`;
    case 'move':
      return `move to ${q(segment.to)} ${unit} (${[segment.law.replace('_', ' '), ...moveLimits(segment)].join(', ')})`;
    case 'sine':
      return `sine ±${q(segment.amplitude)} ${unit} at ${q(segment.frequencyHz)} Hz × ${q(segment.cycles)}`;
    case 'table':
      return `table of ${segment.points.length} points (${segment.interpolation === 'linear' ? 'linear' : 'monotone cubic'}) over ${q(segmentSeconds(segment) ?? 0)} s`;
  }
}

interface ProfileRow {
  readonly text: string;
  /** Start time in s, null once an earlier segment's length depends on the compiled motion. */
  readonly startS: number | null;
}

export interface ProfileView {
  readonly headline: string;
  readonly rows: readonly ProfileRow[];
}

export function profileView(profile: MotionProfile): ProfileView {
  let clock: number | null = 0;
  const rows = profile.segments.map((segment): ProfileRow => {
    const row = { text: segmentText(segment, profile.unit), startS: clock };
    const length = segmentSeconds(segment);
    clock = clock === null || length === null ? null : clock + length;
    return row;
  });
  const repeat = profile.repeat !== undefined && profile.repeat > 1 ? ` × ${profile.repeat}` : '';
  const start = profile.start === undefined ? '' : ` · starts at ${q(profile.start)} ${profile.unit}`;
  return { headline: `${profile.quantity} in ${profile.unit}${start}${repeat}`, rows };
}

export interface LedgerView {
  readonly entries: readonly { readonly element: string; readonly kind: string; readonly joules: number }[];
  readonly inputJ: number;
  readonly dissipatedJ: number;
  readonly storedChangeJ: number;
  readonly closureErrorJ: number;
  readonly closureRelative: number;
  readonly closure: 'pass' | 'warn' | 'fail';
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const NUMBER_KEYS = ['inputJ', 'dissipatedJ', 'storedChangeJ', 'closureErrorJ', 'closureRelative'] as const;

/** The `data.ledger` of simulate_motion (rows as the command defines them), or null when the run has none or it is malformed. */
export function readLedger(data: unknown): LedgerView | null {
  const ledger = isRecord(data) ? data['ledger'] : undefined;
  if (!isRecord(ledger) || !Array.isArray(ledger['entries'])) return null;
  const closure = ledger['closure'];
  if (closure !== 'pass' && closure !== 'warn' && closure !== 'fail') return null;
  const [inputJ, dissipatedJ, storedChangeJ, closureErrorJ, closureRelative] = NUMBER_KEYS.map((key) => ledger[key]);
  if (
    typeof inputJ !== 'number' ||
    typeof dissipatedJ !== 'number' ||
    typeof storedChangeJ !== 'number' ||
    typeof closureErrorJ !== 'number' ||
    typeof closureRelative !== 'number'
  )
    return null;
  const entries: { element: string; kind: string; joules: number }[] = [];
  for (const entry of ledger['entries'] as unknown[]) {
    if (!isRecord(entry)) return null;
    const { element, kind, joules } = entry;
    if (typeof element !== 'string' || typeof kind !== 'string' || typeof joules !== 'number') return null;
    entries.push({ element, kind, joules });
  }
  return { entries, inputJ, dissipatedJ, storedChangeJ, closureErrorJ, closureRelative, closure };
}
