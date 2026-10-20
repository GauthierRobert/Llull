/**
 * Adiabatic heating inputs of the explicit job (RS-8, PHY-19 TECHNICAL_SPEC §13.9): β from the case set-up, the specific heat c_p from the
 * material's PHY-01 cp model in the case unit system (the thermal module's property table): a constant, or the (T in K, c_p) table the
 * solver interpolates at each point's temperature every update.
 */

import type { AnalysisCase } from '@core/model/analysis';
import type { ExplicitSpec } from '@core/model/explicit';
import type { CadDocument } from '@core/model/types';
import { propertyTable } from '../thermal/material';
import type { ExplicitMaterial } from './laws';

export interface JobHeating {
  readonly taylorQuinney: number;
  /** Case unit system (e.g. mJ/(t·K) = mm²/(s²·K) in N-mm-t-s). */
  readonly specificHeat: number;
  /** (temperature K, c_p) points of a temperature-dependent model; empty = the constant. */
  readonly specificHeatTable: readonly (readonly [number, number])[];
}

interface HeatingRefusal {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

/**
 * Heating per entry of `materials` (null: isothermal).
 * @failure heating on a material without the Johnson–Cook strength law -> EXP_MATERIAL_INCOMPLETE; no usable cp model -> EXP_MATERIAL_NO_CP
 */
export function jobHeating(
  doc: CadDocument,
  analysisCase: AnalysisCase,
  spec: ExplicitSpec,
  materials: readonly ExplicitMaterial[],
): readonly (JobHeating | null)[] | HeatingRefusal {
  const heating: (JobHeating | null)[] = [];
  for (const material of materials) {
    const entry = spec.heating?.[material.materialId];
    if (entry === undefined) {
      heating.push(null);
      continue;
    }
    const jc = material.johnsonCook;
    if (jc === undefined)
      return {
        code: 'EXP_MATERIAL_INCOMPLETE',
        message: `material '${material.materialId}' has adiabatic heating but no Johnson-Cook strength law (its plastic work makes the heat)`,
        ids: [material.materialId],
      };
    const documentMaterial = doc.materials[material.materialId];
    const table =
      documentMaterial === undefined
        ? null
        : propertyTable({
            materialName: material.materialId,
            material: documentMaterial,
            documentUnit: doc.units,
            property: 'cp',
            scale: 'K',
            unitSystem: analysisCase.unitSystem,
            required: [jc.transitionK, jc.meltK],
          });
    if (table === null || 'code' in table)
      return {
        code: 'EXP_MATERIAL_NO_CP',
        message: `material '${material.materialId}' has adiabatic heating but no usable specific heat${table !== null && 'message' in table ? `: ${table.message}` : ''}`,
        ids: [material.materialId],
      };
    const specificHeatTable = table.constant === null ? table.points : [];
    const specificHeat = table.constant ?? table.points[0]?.[1] ?? Number.NaN;
    const values = [specificHeat, ...specificHeatTable.map((point) => point[1])];
    if (!values.every((value) => value > 0 && Number.isFinite(value)))
      return {
        code: 'EXP_MATERIAL_NO_CP',
        message: `material '${material.materialId}' has a non-positive specific heat`,
        ids: [material.materialId],
      };
    heating.push({ taylorQuinney: entry.taylorQuinney.value, specificHeat, specificHeatTable });
  }
  return heating;
}
