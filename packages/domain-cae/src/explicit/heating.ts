/**
 * Adiabatic heating inputs of the explicit job (RS-8, PHY-19 TECHNICAL_SPEC §13.9): β from the case set-up, the specific heat c_p from the
 * material's PHY-01 cp model in the case unit system (the thermal module's property table). The solver holds c_p constant: a temperature
 * table is read at the Johnson–Cook transition temperature (where the run starts), reported in `notes`.
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
}

interface HeatingRefusal {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

/** Linear interpolation in a (temperature, value) table, clamped at its ends. */
function valueAt(points: readonly (readonly [number, number])[], temperature: number): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return Number.NaN;
  if (temperature <= first[0]) return first[1];
  if (temperature >= last[0]) return last[1];
  for (let k = 1; k < points.length; k += 1) {
    const [t1, v1] = points[k] ?? last;
    const [t0, v0] = points[k - 1] ?? first;
    if (temperature <= t1) return v0 + ((v1 - v0) * (temperature - t0)) / (t1 - t0);
  }
  return last[1];
}

/**
 * Heating per entry of `materials` (null: isothermal), with notes on held c_p tables.
 * @failure heating on a material without the Johnson–Cook strength law -> EXP_MATERIAL_INCOMPLETE; no usable cp model -> EXP_MATERIAL_NO_CP
 */
export function jobHeating(
  doc: CadDocument,
  analysisCase: AnalysisCase,
  spec: ExplicitSpec,
  materials: readonly ExplicitMaterial[],
): { readonly heating: readonly (JobHeating | null)[]; readonly notes: readonly string[] } | HeatingRefusal {
  const heating: (JobHeating | null)[] = [];
  const notes: string[] = [];
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
    let specificHeat = table.constant ?? valueAt(table.points, jc.transitionK);
    if (table.constant === null)
      notes.push(`c_p of '${material.materialId}' held at its value at T_r = ${jc.transitionK} K (${table.origin})`);
    if (!(specificHeat > 0) || !Number.isFinite(specificHeat)) specificHeat = Number.NaN;
    if (Number.isNaN(specificHeat))
      return {
        code: 'EXP_MATERIAL_NO_CP',
        message: `material '${material.materialId}' has a non-positive specific heat`,
        ids: [material.materialId],
      };
    heating.push({ taylorQuinney: entry.taylorQuinney.value, specificHeat });
  }
  return { heating, notes };
}
