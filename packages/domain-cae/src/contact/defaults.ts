/** CalculiX contact defaults reported as named values (PHY-06 FR-CNT-02 / FR-CNT-14, AF-31). */

import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { elasticConstants, isElasticRefusal, propertyTemperatureK } from '../decks/elastic';
import { stressPerMpa, stressUnitName, lengthUnitName } from '../decks/units';

export interface NamedDefault {
  readonly value: number;
  readonly unit: string;
  readonly source: string;
  readonly defaulted: true;
}

/**
 * The stick slope CalculiX applies when `*FRICTION` gives none: the first elastic constant of the first material of the deck (`M_1` = the
 * material of the first part that has one) / 2, in the analysis unit system.
 * @failure no part with a readable elastic E -> null
 */
export function defaultStickSlope(doc: CadDocument, analysis: AnalysisCase): NamedDefault | null {
  for (const entityId of Object.keys(analysis.parts)) {
    const materialId = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId]?.materialId : undefined;
    const material = materialId !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
    if (materialId === undefined || material === undefined) continue;
    const elastic = elasticConstants(material, materialId, propertyTemperatureK(analysis));
    if (isElasticRefusal(elastic)) return null;
    return {
      value: (elastic.E * stressPerMpa(analysis.unitSystem)) / 2,
      unit: `${stressUnitName(analysis.unitSystem)}/${lengthUnitName(analysis.unitSystem)}`,
      source: `CalculiX *FRICTION default (first elastic constant / 2, material '${materialId}')`,
      defaulted: true,
    };
  }
  return null;
}
