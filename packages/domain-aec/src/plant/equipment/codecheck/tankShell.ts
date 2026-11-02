/**
 * API 650 shell thickness of a tank described in document units (plant 03 EQP §5.6): validation of the one-foot preconditions, allowables from
 * Table 5-2a or the user, minimum thickness by diameter, per-course thicknesses. Pure; shared by `tank_shell_thickness`, `add_storage_tank` (derived
 * course thicknesses) and `check_equipment`.
 * @failure D > 60 m -> EQP_API650_ONE_FOOT_LIMIT; courses not adding up to shellHeight -> EQP_COURSES_MISMATCH; level above the shell ->
 *   EQP_PARAM_INVALID; material outside the table without S_d / S_t -> EQP_MATERIAL_NOT_IN_TABLE
 */

import { findTankMaterial, minimumThicknessRow, TANK_TABLE_EDITION } from '../data/api650Tables';
import { oneFootCourses, ONE_FOOT_LIMIT_M, type CourseThickness } from './api650';
import type { CodeFinding } from './asme';

export const API650_REVIEW_REASON = 'API 650 one-foot thickness computed by llull from the cited formulas; not a certified tank design';

export interface TankShellInput {
  readonly diameter: number;
  readonly shellHeight: number;
  readonly courses: readonly number[];
  readonly designLiquidLevel: number;
  readonly specificGravity: number;
  readonly material: string;
  readonly corrosionAllowance: number;
  readonly allowableStress?: { readonly design: number; readonly test: number; readonly source?: string | undefined } | undefined;
}

export interface TankShellResult {
  readonly diameterM: number;
  readonly courses: CourseThickness[];
  readonly allowableStress: {
    readonly Sd: { readonly value: number; readonly source: string | null };
    readonly St: { readonly value: number; readonly source: string | null };
  };
  readonly maximumGoverningThicknessMm: number;
  readonly warnings: CodeFinding[];
  readonly unverified: boolean;
}

/** @param mmPerUnit millimetres per document unit */
export function tankShellResult(input: TankShellInput, mmPerUnit: number): TankShellResult | { readonly refusal: CodeFinding } {
  const metres = (value: number): number => (value * mmPerUnit) / 1000;
  const refuse = (code: string, message: string, path: string): { refusal: CodeFinding } => ({ refusal: { code, message, paths: [path] } });
  const diameterM = metres(input.diameter);
  if (diameterM > ONE_FOOT_LIMIT_M)
    return refuse('EQP_API650_ONE_FOOT_LIMIT', `D ${diameterM} m exceeds the one-foot limit of ${ONE_FOOT_LIMIT_M} m`, 'diameter');
  const total = input.courses.reduce((sum, height) => sum + height, 0);
  if (Math.abs(total - input.shellHeight) > 1e-6 * input.shellHeight)
    return refuse('EQP_COURSES_MISMATCH', `courses add up to ${total}, shellHeight is ${input.shellHeight}`, 'courses');
  if (input.designLiquidLevel > input.shellHeight * (1 + 1e-9))
    return refuse(
      'EQP_PARAM_INVALID',
      `designLiquidLevel ${input.designLiquidLevel} is above shellHeight ${input.shellHeight}`,
      'designLiquidLevel',
    );
  const row = findTankMaterial(input.material);
  const given = input.allowableStress;
  if (row === undefined && given === undefined)
    return refuse('EQP_MATERIAL_NOT_IN_TABLE', `material '${input.material}' has no S_d / S_t row`, 'material');
  const rowSource = row === undefined ? '' : `API 650 Table 5-2a ${row.material} (data/api650_references.json, grade ${row.grade})`;
  const source = given === undefined ? rowSource : (given.source ?? null);
  const stresses = {
    Sd: { value: given?.design ?? row?.designStressMPa ?? 0, source },
    St: { value: given?.test ?? row?.testStressMPa ?? 0, source },
  };
  const minimum = minimumThicknessRow(diameterM);
  if (minimum === undefined) return refuse('EQP_PARAM_INVALID', `no minimum-thickness row for D ${diameterM} m`, 'diameter');
  const courses = oneFootCourses(
    {
      diameterM,
      courseHeightsM: input.courses.map(metres),
      designLiquidLevelM: metres(input.designLiquidLevel),
      specificGravity: input.specificGravity,
      corrosionAllowanceMm: input.corrosionAllowance * mmPerUnit,
      designStressMPa: stresses.Sd.value,
      testStressMPa: stresses.St.value,
    },
    minimum,
  );
  const warnings: CodeFinding[] = [];
  if (given !== undefined && (given.source === undefined || given.source === ''))
    warnings.push({ code: 'EQP_VALUE_UNSOURCED', message: 'S_d / S_t were given without a source', paths: ['allowableStress.source'] });
  if (minimum.grade !== 'A' || (given === undefined && row !== undefined && row.grade !== 'A'))
    warnings.push({
      code: 'EQP_TABLE_UNVERIFIED',
      message: `minimum nominal thickness for D ${diameterM} m is a grade ${minimum.grade} table row (${TANK_TABLE_EDITION})`,
      paths: ['courses'],
    });
  return {
    diameterM,
    courses,
    allowableStress: stresses,
    maximumGoverningThicknessMm: Math.max(...courses.map((course) => course.governingThicknessMm)),
    warnings,
    unverified: warnings.length > 0,
  };
}
