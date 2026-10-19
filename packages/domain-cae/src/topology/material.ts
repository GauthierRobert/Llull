/** The elastic constants a topology study solves with: E and nu of the (single) material of its design domain. */

import type { TopologyStudy } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import { elasticConstants, isElasticRefusal, ROOM_TEMPERATURE_K, type ElasticConstants } from '../decks/elastic';

/**
 * @failure domain entities without one shared material, or a material without E / nu -> a one-line explanation
 */
export function elasticOf(doc: CadDocument, study: TopologyStudy): ElasticConstants | string {
  const materialIds = new Set(study.designDomain.map((id) => (Object.hasOwn(doc.entities, id) ? doc.entities[id]?.materialId : undefined)));
  const materialId = [...materialIds][0];
  const material = materialId !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  if (materialIds.size !== 1 || materialId === undefined || material === undefined)
    return 'every design-domain entity needs the same material (assign_material)';
  const elastic = elasticConstants(material, materialId, ROOM_TEMPERATURE_K);
  return isElasticRefusal(elastic) ? `material '${materialId}': ${elastic.code} - ${elastic.message}` : elastic;
}
