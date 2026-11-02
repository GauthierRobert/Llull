import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { toMetres, toMm } from '@core/model/units';
import { findTankMaterial, minimumThicknessRow, TANK_TABLE_EDITION } from '../data/api650Tables';
import { oneFootCourses, ONE_FOOT_LIMIT_M } from '../codecheck/api650';
import { refuse } from '../model';

export const API650_REVIEW_REASON = 'API 650 one-foot thickness computed by llull from the cited formulas; not a certified tank design';

/**
 * @affects none (query: returns the same document; results in `data`)
 * @invariant per course H = designLiquidLevel - bottom of the course; t_d = 4.9 D (H - 0.3) G / S_d + CA, t_t = 4.9 D (H - 0.3) / S_t (H - 0.3 clamped
 *   at 0), governing = max(t_d, t_t, minimum nominal thickness of the diameter); table rows below grade A set `unverified`; reviewRequired is always true
 * @failure D > 60 m -> EQP_API650_ONE_FOOT_LIMIT; material outside the table without S_d / S_t -> EQP_MATERIAL_NOT_IN_TABLE; course heights not adding up
 *   to shellHeight -> EQP_COURSES_MISMATCH; level above the shell or non-positive sizes -> EQP_PARAM_INVALID; refusals leave the document unchanged
 */
export const tankShellThickness = defineCommand({
  name: 'tank_shell_thickness',
  description:
    'Query: API 650 one-foot-method shell thickness, course by course, of a vertical atmospheric storage tank given inline (the add_storage_tank ' +
    'template does not exist yet). SI form: design thickness t_d = 4.9 D (H - 0.3) G / S_d + CA, hydrostatic-test thickness t_t = 4.9 D (H - 0.3) / S_t ' +
    '(D tank diameter m, H design liquid level above the bottom of the course m, G specific gravity, S_d / S_t MPa), governing = max(t_d, t_t, ' +
    'minimum nominal thickness for D). S_d / S_t come from the shipped Table 5-2a rows (A283M Gr C 137/154, A36M 160/171, A516M Gr 485 / A516-70 ' +
    '173/195 MPa) or from `allowableStress` with a source. Lengths are in document units. Returns courses[{course, H_m, designThicknessMm, ' +
    'testThicknessMm, minimumThickness{mm, source, unverified}, governingThicknessMm, governing}], allowableStress{Sd, St}{value, source}, ' +
    'unverified (true when a grade B/C minimum-thickness row was used), warnings, reviewRequired (always true), reviewReason. Refusals: ' +
    'EQP_API650_ONE_FOOT_LIMIT (D > 60 m), EQP_MATERIAL_NOT_IN_TABLE, EQP_COURSES_MISMATCH, EQP_PARAM_INVALID. Does not modify the document.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    method: z.literal('one_foot').optional().describe('Only "one_foot" (default) is built; the variable-design-point method is V2.'),
    diameter: z.number().positive().describe('Nominal tank diameter D, document units (at most 60 m).'),
    shellHeight: z.number().positive().describe('Total shell height, document units; the courses must add up to it.'),
    courses: z.array(z.number().positive()).min(1).max(40).describe('Course heights from the bottom, document units.'),
    designLiquidLevel: z.number().positive().describe('Design liquid level above the tank bottom, document units, at most shellHeight.'),
    specificGravity: z.number().positive().describe('Design specific gravity G of the product (water = 1).'),
    material: z
      .string()
      .min(1)
      .describe('Shell plate material, e.g. "A36M", "A283M Gr C", "A516-70". Not in the table: give allowableStress.'),
    corrosionAllowance: z.number().min(0).describe('Corrosion allowance CA, document units (added to the design thickness).'),
    allowableStress: z
      .object({
        design: z.number().positive().describe('Product-design allowable stress S_d, MPa.'),
        test: z.number().positive().describe('Hydrostatic-test allowable stress S_t, MPa.'),
        source: z.string().optional().describe('Where S_d / S_t come from; unsourced values make the result unverified.'),
      })
      .optional()
      .describe('S_d / S_t for a material outside the shipped table (MPa) or overriding it.'),
  }),
  run: (doc, params): CommandResult => {
    const command = 'tank_shell_thickness';
    const diameterM = toMetres(doc, params.diameter);
    if (diameterM > ONE_FOOT_LIMIT_M)
      return refuse(
        doc,
        command,
        'EQP_API650_ONE_FOOT_LIMIT',
        `${command}: D ${diameterM} m exceeds the one-foot limit of ${ONE_FOOT_LIMIT_M} m`,
        [],
        ['diameter'],
      );
    const total = params.courses.reduce((sum, height) => sum + height, 0);
    if (Math.abs(total - params.shellHeight) > 1e-6 * params.shellHeight)
      return refuse(
        doc,
        command,
        'EQP_COURSES_MISMATCH',
        `${command}: courses add up to ${total}, shellHeight is ${params.shellHeight}`,
        [],
        ['courses'],
      );
    if (params.designLiquidLevel > params.shellHeight * (1 + 1e-9))
      return refuse(
        doc,
        command,
        'EQP_PARAM_INVALID',
        `${command}: designLiquidLevel ${params.designLiquidLevel} is above shellHeight ${params.shellHeight}`,
        [],
        ['designLiquidLevel'],
      );
    const row = findTankMaterial(params.material);
    const given = params.allowableStress;
    if (row === undefined && given === undefined)
      return refuse(
        doc,
        command,
        'EQP_MATERIAL_NOT_IN_TABLE',
        `${command}: material '${params.material}' has no S_d / S_t row`,
        [],
        ['material'],
      );
    const rowSource = row === undefined ? '' : `API 650 Table 5-2a ${row.material} (data/api650_references.json, grade ${row.grade})`;
    const stresses = {
      Sd: { value: given?.design ?? row?.designStressMPa ?? 0, source: given === undefined ? rowSource : (given.source ?? null) },
      St: { value: given?.test ?? row?.testStressMPa ?? 0, source: given === undefined ? rowSource : (given.source ?? null) },
    };
    const minimum = minimumThicknessRow(diameterM);
    if (minimum === undefined)
      return refuse(doc, command, 'EQP_PARAM_INVALID', `${command}: no minimum-thickness row for D ${diameterM} m`, [], ['diameter']);
    const courses = oneFootCourses(
      {
        diameterM,
        courseHeightsM: params.courses.map((height) => toMetres(doc, height)),
        designLiquidLevelM: toMetres(doc, params.designLiquidLevel),
        specificGravity: params.specificGravity,
        corrosionAllowanceMm: toMm(doc, params.corrosionAllowance),
        designStressMPa: stresses.Sd.value,
        testStressMPa: stresses.St.value,
      },
      minimum,
    );
    const warnings: Array<{ code: string; message: string; paths: string[] }> = [];
    const unsourced = given !== undefined && (given.source === undefined || given.source === '');
    if (unsourced)
      warnings.push({ code: 'EQP_VALUE_UNSOURCED', message: 'S_d / S_t were given without a source', paths: ['allowableStress.source'] });
    const tableUnverified = minimum.grade !== 'A' || (given === undefined && row !== undefined && row.grade !== 'A');
    if (tableUnverified)
      warnings.push({
        code: 'EQP_TABLE_UNVERIFIED',
        message: `minimum nominal thickness for D ${diameterM} m is a grade ${minimum.grade} table row (${TANK_TABLE_EDITION})`,
        paths: ['courses'],
      });
    const governing = Math.max(...courses.map((course) => course.governingThicknessMm));
    const data = {
      method: 'one_foot',
      diameterM,
      courses,
      allowableStress: stresses,
      maximumGoverningThicknessMm: governing,
      warnings,
      unverified: warnings.length > 0,
      reviewRequired: true,
      reviewReason: API650_REVIEW_REASON,
      provenance: {
        formulas: 'API 650 one-foot method, SI form (public extracts S15, S16 of validation/sources.md)',
        minimumThickness: TANK_TABLE_EDITION,
      },
    };
    return report(
      doc,
      `tank_shell_thickness: D ${diameterM} m, ${courses.length} course(s), bottom course ${courses[0]?.governingThicknessMm.toPrecision(6)} mm (${courses[0]?.governing}), max ${governing.toPrecision(6)} mm${warnings.length > 0 ? ' (unverified, see warnings)' : ''}; review required.`,
      data,
    );
  },
});
