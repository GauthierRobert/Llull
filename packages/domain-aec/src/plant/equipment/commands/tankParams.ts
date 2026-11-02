/**
 * Parameter schemas of `add_storage_tank` and the one builder that turns their input into a validated `TankTemplate`. Every refusal is a coded
 * issue with a param path; every default is named in `defaulted`. Course thicknesses are the user's, else the API 650 one-foot governing thickness.
 */

import { z } from '@core/commands/schema';
import type { DocumentUnit } from '@core/model/types';
import { fromMm, MM_PER_UNIT } from '@core/model/units';
import { tankShellResult } from '../codecheck/tankShell';
import type { TankTemplate } from '../plantData';
import type { VesselIssue } from './vesselParams';

export const tankShape = {
  standard: z
    .literal('api_650')
    .optional()
    .describe('Only "api_650" (vertical atmospheric storage tank, one-foot method) is built. Default api_650.'),
  diameter: z
    .number()
    .positive()
    .describe(
      'Nominal tank diameter D, document units. It is the INSIDE diameter of the shell: the wall grows outward. Above 60 m the thickness cannot be derived.',
    ),
  shellHeight: z.number().positive().describe('Total shell height, document units; the courses must add up to it.'),
  courses: z.array(z.number().positive()).min(1).max(40).describe('Course heights from the bottom, document units.'),
  courseThicknesses: z
    .array(z.number().positive())
    .max(40)
    .optional()
    .describe(
      'Nominal plate thickness of each course (corrosion allowance included), document units, one per course. Omit to use the API 650 one-foot governing thickness ' +
        '(reported as a default, and check_equipment then warns that the thicknesses are not an input).',
    ),
  roof: z
    .object({
      type: z.enum(['cone', 'dome', 'flat']).describe('cone: needs slopeRatio. dome: needs radius. flat: nothing more.'),
      slopeRatio: z
        .union([z.string(), z.number()])
        .optional()
        .describe('cone only: rise per unit run, as "1:12" (rise:run) or a number (0.0833). Between 0 and 1.'),
      radius: z
        .number()
        .positive()
        .optional()
        .describe('dome only: radius of the roof sphere, document units; must exceed the eave radius + thickness.'),
      thickness: z
        .number()
        .positive()
        .optional()
        .describe('Roof plate thickness, document units. Default 5 mm (API 650 minimum nominal roof plate, reported in defaulted).'),
    })
    .describe('Fixed roof. The roof is a thin plate: volume and weight come from its area x thickness.'),
  bottom: z
    .object({
      type: z.literal('flat').optional().describe('Only a flat bottom is built (cone-up / cone-down bottoms are V1).'),
      annularPlate: z
        .boolean()
        .optional()
        .describe('Annular plate ring under the shell: stored only, the ring is not modelled. Default false.'),
      thickness: z
        .number()
        .positive()
        .optional()
        .describe('Bottom plate thickness, document units. Default 6 mm (API 650 minimum bottom plate, reported in defaulted).'),
    })
    .optional()
    .describe('Tank bottom. The shell starts on top of the bottom plate and liquid levels count from there.'),
  design: z
    .object({
      specificGravity: z.number().positive().describe('Design specific gravity G of the product (water = 1).'),
      designLiquidLevel: z.number().positive().describe('Design liquid level above the shell base, document units, at most shellHeight.'),
      material: z
        .string()
        .min(1)
        .describe('Shell plate material, e.g. "A36M", "A283M Gr C", "A516-70". Not in the table: give allowableStress.'),
      corrosionAllowance: z.number().min(0).describe('Corrosion allowance CA of the shell, document units.'),
      allowableStress: z
        .object({
          design: z.number().positive().describe('Product-design allowable stress S_d, MPa.'),
          test: z.number().positive().describe('Hydrostatic-test allowable stress S_t, MPa.'),
          source: z.string().optional().describe('Where S_d / S_t come from; unsourced values are flagged by checks.'),
        })
        .optional()
        .describe('S_d / S_t for a material outside the shipped Table 5-2a rows (MPa) or overriding them.'),
      materialDensityKgM3: z.number().positive().optional().describe('Metal density, kg/m3. Default 7850 (steel), reported in the notes.'),
    })
    .describe('Design data of the tank.'),
};

const tankInput = z.object(tankShape);
export type TankInput = z.infer<typeof tankInput>;

const issue = (code: string, message: string, path: string): VesselIssue => ({ code, message, path });

/** Rise per unit run of `"1:12"` or a number; null when it is not in (0, 1]. */
export function parseSlope(value: string | number): number | null {
  const match = typeof value === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(value) : null;
  const slope = typeof value === 'number' ? value : match === null ? Number.NaN : Number(match[1]) / Number(match[2]);
  return Number.isFinite(slope) && slope > 0 && slope <= 1 ? slope : null;
}

const SHELL_PATHS: Readonly<Record<string, string>> = { designLiquidLevel: 'design.designLiquidLevel', material: 'design.material' };

/**
 * Validated template of `input`, with the names of the defaults applied.
 * @failure courses not adding up -> EQP_COURSES_MISMATCH; thicknesses of the wrong count or <= allowance, level above the shell, roof without slope / radius
 *   or a dome sphere smaller than the eave -> EQP_PARAM_INVALID; no thicknesses and D > 60 m -> EQP_API650_ONE_FOOT_LIMIT; no thicknesses and a material outside
 *   the table without allowableStress -> EQP_MATERIAL_NOT_IN_TABLE
 */
export function buildTankTemplate(input: TankInput, units: DocumentUnit): { template: TankTemplate; defaulted: string[] } | VesselIssue {
  const defaulted: string[] = [];
  const { design } = input;
  const total = input.courses.reduce((sum, height) => sum + height, 0);
  if (Math.abs(total - input.shellHeight) > 1e-6 * input.shellHeight)
    return issue('EQP_COURSES_MISMATCH', `courses add up to ${total}, shellHeight is ${input.shellHeight}`, 'courses');
  if (design.designLiquidLevel > input.shellHeight * (1 + 1e-9))
    return issue(
      'EQP_PARAM_INVALID',
      `designLiquidLevel ${design.designLiquidLevel} is above shellHeight ${input.shellHeight}`,
      'design.designLiquidLevel',
    );
  let courseThicknesses: number[];
  let thicknessSource: TankTemplate['thicknessSource'] = 'user';
  if (input.courseThicknesses !== undefined) {
    if (input.courseThicknesses.length !== input.courses.length)
      return issue(
        'EQP_PARAM_INVALID',
        `courseThicknesses has ${input.courseThicknesses.length} entries, courses has ${input.courses.length}`,
        'courseThicknesses',
      );
    const thin = input.courseThicknesses.findIndex((thickness) => thickness <= design.corrosionAllowance);
    if (thin >= 0)
      return issue(
        'EQP_PARAM_INVALID',
        `courseThicknesses[${thin}] = ${input.courseThicknesses[thin]} must exceed the corrosion allowance ${design.corrosionAllowance}`,
        `courseThicknesses.${thin}`,
      );
    courseThicknesses = input.courseThicknesses;
  } else {
    const derived = tankShellResult(
      {
        diameter: input.diameter,
        shellHeight: input.shellHeight,
        courses: input.courses,
        designLiquidLevel: design.designLiquidLevel,
        specificGravity: design.specificGravity,
        material: design.material,
        corrosionAllowance: design.corrosionAllowance,
        allowableStress: design.allowableStress,
      },
      MM_PER_UNIT[units],
    );
    if ('refusal' in derived) {
      const { code, message, paths } = derived.refusal;
      return issue(
        code,
        `${message} (give courseThicknesses to build the tank anyway)`,
        SHELL_PATHS[paths[0] as string] ?? (paths[0] as string),
      );
    }
    courseThicknesses = derived.courses.map((course) => course.governingThicknessMm / MM_PER_UNIT[units]);
    thicknessSource = derived.courses.every((course) => course.governing === 'minimum') ? 'minimum' : 'one_foot';
    defaulted.push('courseThicknesses');
  }
  const { roof } = input;
  const roofThickness = roof.thickness ?? fromMm({ units }, 5);
  if (roof.thickness === undefined) defaulted.push('roof.thickness');
  const eave = input.diameter / 2 + (courseThicknesses[courseThicknesses.length - 1] as number);
  let roofShape: Pick<TankTemplate['roof'], 'slope' | 'radius'> = {};
  if (roof.type === 'cone') {
    const slope = roof.slopeRatio === undefined ? null : parseSlope(roof.slopeRatio);
    if (slope === null)
      return issue(
        'EQP_PARAM_INVALID',
        'a cone roof needs slopeRatio as "rise:run" (e.g. "1:12") or a number in (0, 1]',
        'roof.slopeRatio',
      );
    roofShape = { slope };
  } else if (roof.type === 'dome') {
    if (roof.radius === undefined || roof.radius - roofThickness <= eave)
      return issue(
        'EQP_PARAM_INVALID',
        `a dome roof needs radius above the eave radius ${eave} plus the roof thickness ${roofThickness}`,
        'roof.radius',
      );
    roofShape = { radius: roof.radius };
  }
  const bottomThickness = input.bottom?.thickness ?? fromMm({ units }, 6);
  if (input.bottom?.thickness === undefined) defaulted.push('bottom.thickness');
  if (input.bottom?.annularPlate === undefined) defaulted.push('bottom.annularPlate');
  const template: TankTemplate = {
    kind: 'tank',
    standard: 'api_650',
    diameter: input.diameter,
    shellHeight: input.shellHeight,
    courses: input.courses,
    courseThicknesses,
    thicknessSource,
    roof: { type: roof.type, ...roofShape, thickness: roofThickness },
    bottom: { type: 'flat', annularPlate: input.bottom?.annularPlate ?? false, thickness: bottomThickness },
    design: { ...design },
    defaulted,
  };
  return { template, defaulted };
}
