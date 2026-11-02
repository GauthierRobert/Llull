import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { MM_PER_UNIT } from '@core/model/units';
import { getBuilding } from '../../../building/model';
import { API650_REVIEW_REASON, tankShellResult, type TankShellInput } from '../codecheck/tankShell';
import { TANK_TABLE_EDITION } from '../data/api650Tables';
import { refuse } from '../model';
import { equipmentRefParam, findEquipment } from './equipmentRef';

const INLINE_FIELDS = [
  'diameter',
  'shellHeight',
  'courses',
  'designLiquidLevel',
  'specificGravity',
  'material',
  'corrosionAllowance',
] as const;

const params = z.object({
  equipment: equipmentRefParam.optional().describe('Tag or id of a tank from add_storage_tank. Replaces the inline description below.'),
  method: z.literal('one_foot').optional().describe('Only "one_foot" (default) is built; the variable-design-point method is V2.'),
  overrideDiameterM: z
    .number()
    .positive()
    .optional()
    .describe('Equipment form only: what-if diameter in METRES replacing the tank diameter for this query (the document is not changed).'),
  diameter: z.number().positive().optional().describe('Inline form: nominal tank diameter D, document units (at most 60 m).'),
  shellHeight: z.number().positive().optional().describe('Inline form: total shell height, document units; the courses must add up to it.'),
  courses: z
    .array(z.number().positive())
    .min(1)
    .max(40)
    .optional()
    .describe('Inline form: course heights from the bottom, document units.'),
  designLiquidLevel: z
    .number()
    .positive()
    .optional()
    .describe('Inline form: design liquid level above the tank bottom, document units, at most shellHeight.'),
  specificGravity: z.number().positive().optional().describe('Inline form: design specific gravity G of the product (water = 1).'),
  material: z
    .string()
    .min(1)
    .optional()
    .describe('Inline form: shell plate material, e.g. "A36M", "A283M Gr C", "A516-70". Not in the table: give allowableStress.'),
  corrosionAllowance: z
    .number()
    .min(0)
    .optional()
    .describe('Inline form: corrosion allowance CA, document units (added to the design thickness).'),
  allowableStress: z
    .object({
      design: z.number().positive().describe('Product-design allowable stress S_d, MPa.'),
      test: z.number().positive().describe('Hydrostatic-test allowable stress S_t, MPa.'),
      source: z.string().optional().describe('Where S_d / S_t come from; unsourced values make the result unverified.'),
    })
    .optional()
    .describe('Inline form: S_d / S_t for a material outside the shipped table (MPa) or overriding it.'),
});

type Params = z.infer<typeof params>;
type Resolved = { readonly input: TankShellInput; readonly identity: Record<string, unknown> } | { readonly result: CommandResult };

/** The tank to compute: the stored one (`equipment`, optional what-if diameter) or the inline description. */
function resolveInput(doc: CadDocument, p: Params): Resolved {
  const command = 'tank_shell_thickness';
  const fail = (code: string, message: string, path: string, ids: string[] = []): Resolved => ({
    result: refuse(doc, command, code, message, ids, [path]),
  });
  const inline = INLINE_FIELDS.filter((name) => p[name] !== undefined);
  if (p.equipment === undefined) {
    if (p.overrideDiameterM !== undefined)
      return fail('EQP_PARAM_INVALID', 'overrideDiameterM needs the equipment form', 'overrideDiameterM');
    const missing = INLINE_FIELDS.find((name) => p[name] === undefined);
    if (missing !== undefined) return fail('EQP_PARAM_INVALID', `give equipment, or the inline tank (${missing} is missing)`, missing);
    return {
      input: {
        diameter: p.diameter as number,
        shellHeight: p.shellHeight as number,
        courses: p.courses as number[],
        designLiquidLevel: p.designLiquidLevel as number,
        specificGravity: p.specificGravity as number,
        material: p.material as string,
        corrosionAllowance: p.corrosionAllowance as number,
        allowableStress: p.allowableStress,
      },
      identity: {},
    };
  }
  if (inline.length > 0 || p.allowableStress !== undefined)
    return fail('EQP_PARAM_INVALID', 'give equipment OR the inline tank, not both', inline[0] ?? 'allowableStress');
  const element = findEquipment(getBuilding(doc), p.equipment);
  if (element === undefined) return fail('EQP_NOT_FOUND', `no equipment with tag or id '${p.equipment}'`, 'equipment');
  const template = element.plant?.template;
  if (template?.kind !== 'tank')
    return fail('EQP_NOT_PARAMETRIC', `${element.mark} (${element.id}) is not a tank from add_storage_tank`, 'equipment', [element.id]);
  const diameter = p.overrideDiameterM === undefined ? template.diameter : (p.overrideDiameterM * 1000) / MM_PER_UNIT[doc.units];
  return {
    input: {
      diameter,
      shellHeight: template.shellHeight,
      courses: template.courses,
      designLiquidLevel: template.design.designLiquidLevel,
      specificGravity: template.design.specificGravity,
      material: template.design.material,
      corrosionAllowance: template.design.corrosionAllowance,
      allowableStress: template.design.allowableStress,
    },
    identity: {
      equipment: element.mark,
      elementId: element.id,
      ...(p.overrideDiameterM === undefined ? {} : { overrideDiameterM: p.overrideDiameterM }),
    },
  };
}

/**
 * @affects none (query: returns the same document; results in `data`)
 * @invariant per course H = designLiquidLevel - bottom of the course; t_d = 4.9 D (H - 0.3) G / S_d + CA, t_t = 4.9 D (H - 0.3) / S_t (H - 0.3 clamped
 *   at 0), governing = max(t_d, t_t, minimum nominal thickness of the diameter); table rows below grade A set `unverified`; reviewRequired is always true;
 *   overrideDiameterM replaces the stored diameter for the query only
 * @failure D > 60 m -> EQP_API650_ONE_FOOT_LIMIT; material outside the table without S_d / S_t -> EQP_MATERIAL_NOT_IN_TABLE; course heights not adding up
 *   to shellHeight -> EQP_COURSES_MISMATCH; level above the shell or non-positive sizes -> EQP_PARAM_INVALID; unknown / non-tank equipment ->
 *   EQP_NOT_FOUND / EQP_NOT_PARAMETRIC; refusals leave the document unchanged
 */
export const tankShellThickness = defineCommand({
  name: 'tank_shell_thickness',
  description:
    'Query: API 650 one-foot-method shell thickness, course by course, of a vertical atmospheric storage tank. Give EITHER `equipment` (tag or id of a tank ' +
    'from add_storage_tank; optional overrideDiameterM = what-if diameter in metres) OR the tank inline (diameter, shellHeight, courses, designLiquidLevel, ' +
    'specificGravity, material, corrosionAllowance, optional allowableStress). SI form: design thickness t_d = 4.9 D (H - 0.3) G / S_d + CA, hydrostatic-test ' +
    'thickness t_t = 4.9 D (H - 0.3) / S_t (D tank diameter m, H design liquid level above the bottom of the course m, G specific gravity, S_d / S_t MPa), ' +
    'governing = max(t_d, t_t, minimum nominal thickness for D). S_d / S_t come from the shipped Table 5-2a rows (A283M Gr C 137/154, A36M 160/171, ' +
    'A516M Gr 485 / A516-70 173/195 MPa) or from `allowableStress` with a source. Lengths are in document units. Returns courses[{course, H_m, ' +
    'designThicknessMm, testThicknessMm, minimumThickness{mm, source, unverified}, governingThicknessMm, governing}], allowableStress{Sd, St}{value, source}, ' +
    'unverified (true when a grade B/C minimum-thickness row was used), warnings, reviewRequired (always true), reviewReason. Refusals: ' +
    'EQP_API650_ONE_FOOT_LIMIT (D > 60 m), EQP_MATERIAL_NOT_IN_TABLE, EQP_COURSES_MISMATCH, EQP_NOT_FOUND, EQP_NOT_PARAMETRIC, EQP_PARAM_INVALID. ' +
    'Does not modify the document.',
  annotations: { readOnly: true, idempotent: true },
  params,
  run: (doc, p): CommandResult => {
    const resolved = resolveInput(doc, p);
    if ('result' in resolved) return resolved.result;
    const outcome = tankShellResult(resolved.input, MM_PER_UNIT[doc.units]);
    if ('refusal' in outcome) {
      const { code, message, paths } = outcome.refusal;
      return refuse(doc, 'tank_shell_thickness', code, message, [], [...paths]);
    }
    const { courses, warnings, maximumGoverningThicknessMm: governing } = outcome;
    const data = {
      method: 'one_foot',
      ...resolved.identity,
      diameterM: outcome.diameterM,
      courses,
      allowableStress: outcome.allowableStress,
      maximumGoverningThicknessMm: governing,
      warnings,
      unverified: outcome.unverified,
      reviewRequired: true,
      reviewReason: API650_REVIEW_REASON,
      provenance: {
        formulas: 'API 650 one-foot method, SI form (public extracts S15, S16 of validation/sources.md)',
        minimumThickness: TANK_TABLE_EDITION,
      },
    };
    return report(
      doc,
      `tank_shell_thickness: D ${outcome.diameterM} m, ${courses.length} course(s), bottom course ${courses[0]?.governingThicknessMm.toPrecision(6)} mm (${courses[0]?.governing}), max ${governing.toPrecision(6)} mm${warnings.length > 0 ? ' (unverified, see warnings)' : ''}; review required.`,
      data,
    );
  },
});
