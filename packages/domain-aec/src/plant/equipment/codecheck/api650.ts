/**
 * API 650 one-foot method shell thickness (plant 03 EQP §5.6), SI form: t_d = 4.9 D (H - 0.3) G / S_d + CA, t_t = 4.9 D (H - 0.3) / S_t, per course
 * governing t = max(t_d, t_t, minimum nominal thickness of the diameter). D m, H m, S MPa, t mm. Pure; used by `tank_shell_thickness`.
 */

import type { MinimumThicknessRow } from '../data/api650Tables';

export const ONE_FOOT_LIMIT_M = 60;

export interface CourseThickness {
  readonly course: number;
  readonly bottomM: number;
  readonly heightM: number;
  /** Design liquid level above the bottom of the course; the thickness terms use it clamped at 0.3 m (H - 0.3 >= 0). */
  readonly H_m: number;
  readonly designThicknessMm: number;
  readonly testThicknessMm: number;
  readonly minimumThickness: { readonly mm: number; readonly source: string; readonly unverified: boolean };
  readonly governingThicknessMm: number;
  readonly governing: 'design' | 'test' | 'minimum';
}

export interface OneFootInput {
  readonly diameterM: number;
  readonly courseHeightsM: readonly number[];
  readonly designLiquidLevelM: number;
  readonly specificGravity: number;
  readonly corrosionAllowanceMm: number;
  readonly designStressMPa: number;
  readonly testStressMPa: number;
}

/** @invariant the minimum row is the one of the diameter; its grade below A sets `minimumThickness.unverified` */
export function oneFootCourses(input: OneFootInput, minimum: MinimumThicknessRow): CourseThickness[] {
  const { diameterM, designLiquidLevelM, specificGravity, corrosionAllowanceMm } = input;
  let bottom = 0;
  return input.courseHeightsM.map((height, index) => {
    const H = designLiquidLevelM - bottom;
    const head = 4.9 * diameterM * Math.max(0, H - 0.3);
    const design = (head * specificGravity) / input.designStressMPa + corrosionAllowanceMm;
    const test = head / input.testStressMPa;
    const governingThicknessMm = Math.max(design, test, minimum.thicknessMm);
    const row: CourseThickness = {
      course: index + 1,
      bottomM: bottom,
      heightM: height,
      H_m: H,
      designThicknessMm: design,
      testThicknessMm: test,
      minimumThickness: {
        mm: minimum.thicknessMm,
        source: `API 650 minimum nominal thickness for D ${diameterM} m (grade ${minimum.grade} row)`,
        unverified: minimum.grade !== 'A',
      },
      governingThicknessMm,
      governing: governingThicknessMm === minimum.thicknessMm ? 'minimum' : governingThicknessMm === design ? 'design' : 'test',
    };
    bottom += height;
    return row;
  });
}
