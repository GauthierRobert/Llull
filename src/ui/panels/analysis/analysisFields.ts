// Which result fields / load cases / times an analysis case offers, and the render_fea_results parameters the panel and the 3D overlay share.

import type { AnalysisCase } from '@core/model/analysis';

const STRUCTURAL_FIELDS = ['von_mises', 'u_mag', 'u_x', 'u_y', 'u_z', 's_xx', 's_yy', 's_zz'] as const;
const THERMAL_FIELDS = ['temperature', 'heat_flux'] as const;
const EIGEN_FIELDS = ['mode'] as const;

export const isEigen = (analysisCase: AnalysisCase): boolean => analysisCase.type === 'modal' || analysisCase.type === 'buckling';
export const isHeat = (analysisCase: AnalysisCase): boolean =>
  analysisCase.type === 'heat_steady' || analysisCase.type === 'heat_transient';

export function fieldsOf(analysisCase: AnalysisCase): readonly string[] {
  return isHeat(analysisCase) ? THERMAL_FIELDS : isEigen(analysisCase) ? EIGEN_FIELDS : STRUCTURAL_FIELDS;
}

export const loadCasesOf = (analysisCase: AnalysisCase): string[] => [
  ...new Set(Object.values(analysisCase.loads).map((load) => load.loadCase)),
];

export const timesOf = (analysisCase: AnalysisCase): readonly number[] =>
  analysisCase.type === 'heat_transient' ? (analysisCase.results?.thermal?.times ?? []) : [];

/** What the user picked for the plotted result; empty strings / null mean "the command's default". */
export interface ResultChoice {
  readonly field: string | null;
  readonly loadCase: string;
  readonly time: string;
  readonly scale: string;
  readonly mode: number;
}

export function resolvedField(analysisCase: AnalysisCase, choice: ResultChoice): string {
  const fields = fieldsOf(analysisCase);
  return choice.field !== null && fields.includes(choice.field) ? choice.field : (fields[0] ?? 'von_mises');
}

/** render_fea_results parameters of the chosen result (view / mesh-edge options are added by the caller). */
export function resultParams(analysisCase: AnalysisCase, choice: ResultChoice): Record<string, unknown> {
  const scaleValue = choice.scale.trim() === '' ? Number.NaN : Number(choice.scale);
  const heat = isHeat(analysisCase);
  const eigen = isEigen(analysisCase);
  return {
    analysisId: analysisCase.id,
    field: resolvedField(analysisCase, choice),
    ...(eigen && Number.isInteger(choice.mode) && choice.mode >= 1 ? { mode: choice.mode } : {}),
    ...(choice.time !== '' && heat ? { time: Number(choice.time) } : {}),
    ...(choice.loadCase !== '' && !heat && !eigen ? { loadCase: choice.loadCase } : {}),
    ...(Number.isFinite(scaleValue) && scaleValue >= 0 && !heat && !eigen ? { deformationScale: scaleValue } : {}),
  };
}
