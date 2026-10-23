/** The material a topology study solves with: E and nu of the (single) material of its design domain, and its density for gravity. */

import type { UnitSystem } from '@core/model/analysis';
import type { TopologyStudy } from '@core/model/topology';
import type { CadDocument, Material } from '@core/model/types';
import { elasticConstants, isElasticRefusal, ROOM_TEMPERATURE_K, type ElasticConstants } from '../decks/elastic';
import { densityToAnalysis } from '../decks/units';

/** The one material shared by the design domain, or the reason there is none. */
function sharedMaterial(doc: CadDocument, study: TopologyStudy): { readonly id: string; readonly material: Material } | string {
  const materialIds = new Set(study.designDomain.map((id) => (Object.hasOwn(doc.entities, id) ? doc.entities[id]?.materialId : undefined)));
  const materialId = [...materialIds][0];
  const material = materialId !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  if (materialIds.size !== 1 || materialId === undefined || material === undefined)
    return 'every design-domain entity needs the same material (assign_material)';
  return { id: materialId, material };
}

/**
 * @failure domain entities without one shared material, or a material without E / nu -> a one-line explanation
 */
export function elasticOf(doc: CadDocument, study: TopologyStudy): ElasticConstants | string {
  const shared = sharedMaterial(doc, study);
  if (typeof shared === 'string') return shared;
  const elastic = elasticConstants(shared.material, shared.id, ROOM_TEMPERATURE_K);
  return isElasticRefusal(elastic) ? `material '${shared.id}': ${elastic.code} - ${elastic.message}` : elastic;
}

/**
 * Density of the domain material in the analysis unit system (N-mm-t-s: t/mm^3), for gravity loads.
 * @failure no shared material, or a material whose density is not > 0 -> a one-line explanation
 */
export function densityOf(doc: CadDocument, study: TopologyStudy, unitSystem: UnitSystem): number | string {
  const shared = sharedMaterial(doc, study);
  if (typeof shared === 'string') return shared;
  if (!(shared.material.density > 0) || !Number.isFinite(shared.material.density))
    return `material '${shared.id}' has no density: gravity needs one (create_material density / densityUnit)`;
  return densityToAnalysis(shared.material.density, doc.units, unitSystem);
}
