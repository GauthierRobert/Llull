/**
 * Structural damping from the material (TR-DYN-12): eta = `structuralLossFactor` read through the PHY-01 consumer API
 * (`resolvePropertyModel` then `evaluatePropertyModel` at the case property temperature). CalculiX takes one value per material
 * (`*DAMPING,STRUCTURAL=eta`), so the deck and the post-processing use the same scalar.
 */

import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { evaluatePropertyModel, isRefused, resolvePropertyModel, type PropertyRecord } from '@core/model/propertyModelEval';
import { propertyTemperatureK } from '../decks/elastic';

export interface LossFactor {
  readonly materialId: string;
  readonly eta: number;
  readonly unverifiedReasons: readonly string[];
}

export interface LossFactorRefusal {
  readonly code: 'DYN_MATERIAL_NO_DAMPING';
  readonly message: string;
  readonly ids: readonly string[];
}

/**
 * eta of the material of `entityId`.
 * @failure no material, no structuralLossFactor model, a PHY-01 refusal (code quoted) or eta < 0 -> DYN_MATERIAL_NO_DAMPING
 */
export function lossFactorOf(doc: CadDocument, analysisCase: AnalysisCase, entityId: string): LossFactor | LossFactorRefusal {
  const materialId = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId]?.materialId : undefined;
  const material = materialId !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  const refuse = (message: string): LossFactorRefusal => ({
    code: 'DYN_MATERIAL_NO_DAMPING',
    message,
    ids: [entityId, ...(materialId === undefined ? [] : [materialId])],
  });
  if (material === undefined || materialId === undefined) return refuse(`part '${entityId}' has no material`);
  const record: PropertyRecord = {
    name: materialId,
    ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}),
  };
  const model = resolvePropertyModel(record, { property: 'structuralLossFactor' });
  if (isRefused(model)) return refuse(`material '${materialId}' has no structuralLossFactor property model (${model.code})`);
  const value = evaluatePropertyModel(record, model, { T: { value: propertyTemperatureK(analysisCase), unit: 'K' } }, { outputUnit: '1' });
  if (!value.available) return refuse(`material '${materialId}' structuralLossFactor: ${value.code} ${value.reason}`);
  if (!(value.value >= 0 && Number.isFinite(value.value)))
    return refuse(`material '${materialId}' structuralLossFactor ${value.value} must be >= 0`);
  return { materialId, eta: value.value, unverifiedReasons: value.unverifiedReasons };
}

/**
 * The single loss factor of a structural_material case: every part must resolve one and they must agree (the modal post-processing applies
 * one eta to every mode).
 * @failure any part refusal; parts with different eta -> DYN_MATERIAL_NO_DAMPING
 */
export function caseLossFactor(doc: CadDocument, analysisCase: AnalysisCase): LossFactor | LossFactorRefusal {
  let first: LossFactor | null = null;
  for (const entityId of Object.keys(analysisCase.parts)) {
    const found = lossFactorOf(doc, analysisCase, entityId);
    if ('code' in found) return found;
    if (first !== null && found.eta !== first.eta)
      return {
        code: 'DYN_MATERIAL_NO_DAMPING',
        message: `materials '${first.materialId}' and '${found.materialId}' have different loss factors (${first.eta}, ${found.eta}); modal post-processing needs one eta (use modal damping)`,
        ids: [first.materialId, found.materialId],
      };
    first ??= found;
  }
  return first ?? { code: 'DYN_MATERIAL_NO_DAMPING', message: 'the analysis has no part', ids: [analysisCase.id] };
}
