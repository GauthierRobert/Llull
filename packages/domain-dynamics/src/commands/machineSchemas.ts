/** Zod fragments of the PMSM, stepper and induction datasheets (add_motor kinds "pmsm", "stepper", "induction"; PHY-23 DRV-M4). */

import { z } from '@core/commands/schema';
import type { InductionDatasheet, PmsmDatasheet, StepperDatasheet } from '@core/model/drives';
import { nonNegative, optionalPositive, positive, thermalSchema, withoutUndefined } from './motorSchemas';

export const pmsmSheetSchema = z.object({
  polePairs: z.number().int().positive().describe('Pole pairs p (poles / 2).'),
  phaseResistanceOhm: positive('Phase resistance R, ohm (per phase, at 25 C).'),
  inductanceH: positive('Phase synchronous inductance L = Ld = Lq, H (surface magnets; per phase).'),
  fluxLinkageWb: optionalPositive('Permanent-magnet flux linkage lambda, Wb (peak, per phase). Give this or torqueConstantNmPerA.'),
  torqueConstantNmPerA: optionalPositive(
    'Torque constant Kt, N*m per A of phase-current AMPLITUDE (= 1.5*p*lambda, amplitude-invariant dq). Give this or fluxLinkageWb; with both they are ' +
      'checked against each other. A sheet value per A RMS converts as Kt_amplitude = Kt_rms / sqrt(2).',
  ),
  rotorInertiaKgM2: positive('Rotor moment of inertia, kg*m^2.'),
  busVoltageV: positive('DC bus voltage, V: the phase-voltage amplitude limit is V_bus / sqrt(3) (space-vector modulation).'),
  peakCurrentA: positive('Largest phase-current AMPLITUDE the drive commands, A.'),
  nominalCurrentA: optionalPositive('Continuous phase-current amplitude, A: size_drive holds the RMS demand against it.'),
  maxSpeedRpm: optionalPositive('Maximum permissible speed, rpm: size_drive holds the peak speed against it.'),
  frictionNm: nonNegative('Coulomb friction of the rotor, N*m at the motor shaft. Default 0.'),
  peakTorqueNm: optionalPositive('Peak torque of the sheet, N*m: checked against Kt * peakCurrentA.'),
  noLoadSpeedRpm: optionalPositive('Ideal no-load speed of the sheet, rpm: checked against V_bus / sqrt(3) / (p * lambda).'),
  thermal: thermalSchema.optional(),
});

export const stepperSheetSchema = z.object({
  stepsPerRev: z
    .number()
    .int()
    .positive()
    .multipleOf(4)
    .describe('Full steps per revolution (200 for a 1.8 degree motor, a multiple of 4); rotor teeth = steps / 4.'),
  holdingTorqueNm: positive('Holding torque T_h, N*m (both phases energised, at the rated current).'),
  ratedCurrentA: positive(
    'Rated phase current, A: the chopper setpoint of the drive (set_motor_drive currentLimitA overrides it, torque scales with it).',
  ),
  phaseResistanceOhm: positive('Phase resistance, ohm.'),
  phaseInductanceH: positive(
    'Phase inductance, H: its L/R time constant rolls the pull-out torque off with speed when no pullOutCurve is given.',
  ),
  rotorInertiaKgM2: positive('Rotor moment of inertia, kg*m^2.'),
  detentTorqueNm: nonNegative('Peak detent (cogging) torque with no current, N*m. Default 0.'),
  pullOutCurve: z
    .array(z.tuple([z.number().min(0), z.number().min(0)]))
    .min(1)
    .optional()
    .describe(
      'Datasheet pull-out torque [[rpm, N*m], ...] with strictly increasing rpm, at the rated current: linear between points, zero beyond the last. ' +
        'Without it the torque rolls off as T_h / sqrt(1 + (N_r * w * L / R)^2).',
    ),
  dampingNmsPerRad: nonNegative('Viscous damping of the rotor, N*m*s/rad. Default 0 (an undamped rotor keeps ringing after a step).'),
  stepAngleDeg: optionalPositive('Step angle of the sheet, degrees: checked against 360 / stepsPerRev.'),
  ratedVoltageV: optionalPositive('Rated voltage of the sheet, V: checked against R * rated current.'),
  maxSpeedRpm: optionalPositive('Maximum speed, rpm: size_drive holds the peak speed against it.'),
  thermal: thermalSchema.optional(),
});

export const inductionSheetSchema = z.object({
  polePairs: z.number().int().positive().describe('Pole pairs p.'),
  ratedVoltageV: positive('Rated PHASE voltage, V RMS (line voltage / sqrt(3) for a star connection, the line voltage for a delta).'),
  ratedFrequencyHz: positive('Rated supply frequency, Hz.'),
  statorResistanceOhm: positive('Stator resistance R1 per phase, ohm.'),
  rotorResistanceOhm: positive('Rotor resistance R2 per phase referred to the stator, ohm.'),
  statorLeakageReactanceOhm: z.number().min(0).describe('Stator leakage reactance X1 at the rated frequency, ohm.'),
  rotorLeakageReactanceOhm: z.number().min(0).describe('Rotor leakage reactance X2 referred to the stator at the rated frequency, ohm.'),
  magnetisingReactanceOhm: positive(
    'Magnetising reactance Xm at the rated frequency, ohm (the branch sits at the terminals: it sets the magnetising current, not the torque).',
  ),
  ironLossResistanceOhm: optionalPositive(
    'Iron-loss resistance Rc in parallel with the magnetising branch, ohm: iron loss 3*V^2/Rc. Absent = no iron loss.',
  ),
  rotorInertiaKgM2: positive('Rotor moment of inertia, kg*m^2.'),
  frictionNm: nonNegative('Coulomb friction (friction and windage) at the motor shaft, N*m. Default 0.'),
  nominalCurrentA: optionalPositive(
    'Rated load current I2 of the equivalent circuit, A RMS: size_drive holds the RMS load current against it.',
  ),
  peakCurrentA: optionalPositive('Largest load current allowed, A RMS: size_drive holds the peak against it.'),
  maxSpeedRpm: optionalPositive('Maximum speed, rpm: size_drive holds the peak speed against it.'),
  breakdownTorqueNm: optionalPositive(
    'Breakdown torque of the sheet, N*m: checked against the circuit at the rated voltage and frequency.',
  ),
  breakdownSlip: optionalPositive('Breakdown slip of the sheet: checked against R2 / sqrt(R1^2 + X^2).'),
  startingTorqueNm: optionalPositive('Locked-rotor torque of the sheet, N*m: checked against the circuit at slip 1.'),
  thermal: thermalSchema.optional(),
});

const withThermal = <T extends { thermal?: unknown }>(parsed: T): T =>
  withoutUndefined({
    ...parsed,
    thermal: parsed.thermal === undefined ? undefined : withoutUndefined(parsed.thermal as Record<string, unknown>),
  }) as T;

/** A zod-parsed machine sheet as the model type (no `undefined` members: exactOptionalPropertyTypes). */
export const toPmsmSheet = (parsed: z.infer<typeof pmsmSheetSchema>): PmsmDatasheet => withThermal(parsed) as PmsmDatasheet;
export const toStepperSheet = (parsed: z.infer<typeof stepperSheetSchema>): StepperDatasheet => withThermal(parsed) as StepperDatasheet;
export const toInductionSheet = (parsed: z.infer<typeof inductionSheetSchema>): InductionDatasheet =>
  withThermal(parsed) as InductionDatasheet;
