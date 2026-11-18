/** `pipe_wall_check` (plant 01 PSC M4): ASME B31.3 eq. (3a) pressure design thickness and the lightest schedule that meets it. */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { refuse } from '../codes';
import { type Problem, designInputs, isProblem, resolveSize, wallReport } from './wallPhases';

const nominalParam = z.union([z.number(), z.string()]);
const PRESSURE_UNITS = ['bar', 'psi', 'MPa'] as const;

const quantity = (what: string): z.ZodType<{ value: number; unit: (typeof PRESSURE_UNITS)[number] }> =>
  z.object({ value: z.number().describe(`${what}: value.`), unit: z.enum(PRESSURE_UNITS).describe('bar, psi or MPa.') });

/**
 * @affects none; data = { pressureThicknessMm, minimumThicknessMm, requiredNominalMm, selectedSchedule?, selectedWallMm, lightestSchedule?, candidates, validity, provenance, reviewRequired }
 * @invariant read-only; every input explicit (nothing defaulted); eq. (3a) only for t < D/6 and P/(S E) <= 0.385, else refused; reviewRequired is always true
 * @failure missing S, E, W, Y, c or mill tolerance -> PSC_ALLOWABLE_MISSING; factor outside its range -> PSC_WALL_INPUT_RANGE; t >= D/6 or P/(S E) > 0.385 -> PSC_WALL_THICK_PIPE; wall below the requirement -> PSC_WALL_INSUFFICIENT; unknown size / schedule -> PSC_SIZE_UNKNOWN / PSC_SCHEDULE_UNKNOWN / PSC_CATALOG_ROW_MISSING
 */
export const pipeWallCheck = defineCommand({
  name: 'pipe_wall_check',
  description:
    'Pressure design wall of straight steel pipe under INTERNAL pressure, ASME B31.3 304.1.2 equation (3a): t = P D / (2 (S E W + P Y)), then tm = t + corrosion allowance and the required nominal wall = tm / (1 - mill tolerance). ' +
    'Give the size as nps / dn (outside diameter and schedules from the catalogue, ASME B36.10M by default, or standard "ASME B36.19M") or as odMm (no schedule choice). ' +
    'Nothing is defaulted (safety data): pressure (gauge), allowableStress S, jointFactorE, weldStrengthW, coefficientY, corrosionAllowance and millTolerance (fraction, 0.125 = 12.5 % for seamless pipe, 0 = none) must all be given, else PSC_ALLOWABLE_MISSING; allowable stresses are not shipped (take S from B31.3 Table A-1). ' +
    'The formula is used only where it is defined: t < D/6 and P/(S E) <= 0.385 (else PSC_WALL_THICK_PIPE, thick-wall design needs an engineer), E and W in (0, 1], Y in [0, 0.7], tolerance in [0, 0.5) (else PSC_WALL_INPUT_RANGE). External pressure, bends, branches and creep are out of scope. ' +
    'Without schedule / wallMm it returns the lightest schedule whose wall is at least the required nominal (ties: numbered schedule first); with schedule or wallMm it checks that wall (PSC_WALL_INSUFFICIENT, the lightest sufficient schedule in error.detail). ' +
    'Example: NPS 4, 1200 psi, S 19000 psi, E = W = 1, Y 0.4, c 3 mm, 12.5 %: t 3.5205 mm, required 7.452 mm, Sch 80. Always reviewRequired: a qualified engineer confirms. Next: edit_pipe_spec to put the schedule in a spec.',
  params: z.object({
    nps: nominalParam
      .describe('Nominal pipe size, inch designation ("4", "2-1/2") or number. Give exactly one of nps, dn, odMm.')
      .optional(),
    dn: nominalParam.describe('Nominal diameter DN (converted to NPS for the catalogue).').optional(),
    odMm: z
      .number()
      .positive()
      .describe('Outside diameter in mm, when the size is not a catalogue size (no schedule selection; give wallMm to check a wall).')
      .optional(),
    standard: z
      .string()
      .min(1)
      .describe(
        'Pipe standard whose schedules are searched: "ASME B36.10M" (default) or "ASME B36.19M"; "EN 10220" with an imported catalogue that holds its walls.',
      )
      .optional(),
    catalogId: z.string().describe('Catalogue id (list_piping_catalogs). Default: the bundled llull-open-piping.').optional(),
    schedule: z.string().describe('Check this schedule ("40", "XS", "10S") instead of selecting one.').optional(),
    wallMm: z.number().positive().describe('Check this nominal wall in mm instead of selecting a schedule.').optional(),
    pressure: quantity('Internal design pressure, gauge').describe('Internal design pressure (gauge) with its unit (bar, psi, MPa).'),
    allowableStress: quantity('Allowable stress S at design temperature')
      .describe('Allowable stress S at the design temperature with its unit, from B31.3 Table A-1 (not shipped).')
      .optional(),
    jointFactorE: z.number().describe('Quality factor E in (0, 1] (B31.3 Table A-1B).').optional(),
    weldStrengthW: z
      .number()
      .describe('Weld joint strength reduction factor W in (0, 1] (B31.3 302.3.5; 1 below the creep range).')
      .optional(),
    coefficientY: z
      .number()
      .describe('Coefficient Y in [0, 0.7] (B31.3 Table 304.1.1: 0.4 ferritic steel up to 482 degC, 0.5 austenitic up to 566 degC).')
      .optional(),
    corrosionAllowance: z
      .object({ value: z.number().describe('Allowance value, >= 0.'), unit: z.enum(['mm', 'in']).describe('mm or in.') })
      .describe('Corrosion / erosion / thread allowance c with its unit.')
      .optional(),
    millTolerance: z
      .number()
      .describe('Mill under-tolerance as a fraction of the nominal wall in [0, 0.5): 0.125 for seamless pipe, 0 for none.')
      .optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, params): CommandResult => {
    const refused = ({ problem }: Problem): CommandResult =>
      refuse(doc, 'pipe_wall_check', problem.code, problem.message, problem.ids ?? [], problem.paths);
    const inputs = designInputs(params);
    if (isProblem(inputs)) return refused(inputs);
    const standard = params.standard ?? 'ASME B36.10M';
    const size = resolveSize(doc, params, standard);
    if (isProblem(size)) return refused(size);
    return wallReport(doc, params, inputs, size, standard);
  },
});
