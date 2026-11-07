/** Zod fragments shared by the datasheet-motor commands (add_motor, check_motor_data). */

import { z } from '@core/commands/schema';
import type { DcMotorDatasheet, Gearhead, ParameterSource } from '@core/model/drives';

export const sourceSchema = z.object({
  name: z.string().min(1).describe('Where the numbers come from: catalogue and page, test report, measurement (required, never empty).'),
  url: z.string().optional().describe('Link to the source, when there is one.'),
  grade: z
    .enum(['A', 'B', 'C'])
    .describe('A = primary source read or exact derivation; B = one secondary source; C = assumed or unchecked.'),
});

export const positive = (text: string): z.ZodNumber => z.number().positive().describe(text);
export const nonNegative = (text: string): z.ZodOptional<z.ZodNumber> => z.number().min(0).optional().describe(text);
export const optionalPositive = (text: string): z.ZodOptional<z.ZodNumber> => z.number().positive().optional().describe(text);

export const thermalSchema = z
  .object({
    rthWindingHousingKPerW: positive('Thermal resistance winding-housing, K/W.'),
    rthHousingAmbientKPerW: positive('Thermal resistance housing-ambient, K/W.'),
    tauWindingS: positive('Thermal time constant of the winding, s.'),
    tauMotorS: positive('Thermal time constant of the motor, s.'),
    maxWindingC: positive('Maximum winding temperature, C.'),
    alphaPerK: optionalPositive('Copper temperature coefficient, 1/K. Default 0.0039.'),
  })
  .describe('Thermal data of the winding (size_drive: 2-node network, steady and peak winding temperature, runaway).');

export const datasheetSchema = z.object({
  nominalVoltageV: positive('Nominal terminal voltage U, V.'),
  terminalResistanceOhm: positive('Terminal resistance R, ohm (phase-to-phase, at 25 C).'),
  torqueConstantNmPerA: positive('Torque constant kt, N*m per A (equals the back-EMF constant ke in V*s/rad).'),
  rotorInertiaKgM2: positive('Rotor moment of inertia J, kg*m^2 (the sheet often gives g*cm^2: 1 g*cm^2 = 1e-7 kg*m^2).'),
  terminalInductanceH: nonNegative('Terminal inductance L, H. 0 or absent = the current follows the voltage instantly.'),
  noLoadCurrentA: nonNegative('No-load current I0, A: becomes Coulomb friction kt*I0 on the shaft. 0 = frictionless rotor.'),
  nominalCurrentA: optionalPositive('Nominal (continuous) current, A. Reported by checks; not used by the law.'),
  stallTorqueNm: optionalPositive('Stall torque, N*m: checked against kt*U/R.'),
  stallCurrentA: optionalPositive('Stall current, A: checked against U/R.'),
  noLoadSpeedRpm: optionalPositive('No-load speed, rpm: checked against (U - R*I0)/kt.'),
  speedConstantRpmPerV: optionalPositive('Speed constant, rpm per V: checked against 1/kt.'),
  speedTorqueGradientRpmPerMNm: optionalPositive('Speed/torque gradient, rpm per mN*m: checked against no-load speed / stall torque.'),
  mechanicalTimeConstantS: optionalPositive('Mechanical time constant, s: checked against J*R/kt^2.'),
  maxSpeedRpm: optionalPositive('Maximum permissible speed, rpm. Reported by checks; not used by the law.'),
  peakCurrentA: optionalPositive('Largest current the drive may command, A. Default U / R (stall).'),
  thermal: thermalSchema.optional(),
});

export const gearheadSchema = z.object({
  ratio: positive('Reduction N > 0: joint speed = motor speed / N, joint torque = N*eta*motor torque.'),
  efficiency: z.number().gt(0).max(1).describe('Forward efficiency in (0, 1].'),
  efficiencyBack: z
    .number()
    .gt(0)
    .max(1)
    .optional()
    .describe('Efficiency when the joint drives the motor, in (0, 1]. Default = efficiency.'),
  inertiaKgM2: nonNegative('Gearhead inertia about its input shaft, kg*m^2 (added to the rotor, seen through N^2).'),
});

export const withoutUndefined = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/** Zod's parsed datasheet as the model type (no `undefined` members: exactOptionalPropertyTypes). */
export function toDatasheet(parsed: z.infer<typeof datasheetSchema>): DcMotorDatasheet {
  return withoutUndefined({
    ...parsed,
    thermal: parsed.thermal === undefined ? undefined : withoutUndefined(parsed.thermal),
  }) as DcMotorDatasheet;
}

export function toGearhead(parsed: z.infer<typeof gearheadSchema>): Gearhead {
  return withoutUndefined(parsed) as Gearhead;
}

export function toSource(parsed: z.infer<typeof sourceSchema>): ParameterSource {
  return withoutUndefined(parsed) as ParameterSource;
}
