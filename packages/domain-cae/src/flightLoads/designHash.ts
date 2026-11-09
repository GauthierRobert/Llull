/** Hash of the design a flight run flew (14 FLL FLL_RUN_STALE): changes when anything the run reads changes. */

import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { hashText } from '@lib/hash';

/**
 * Hash of the rigid-body model (`doc.dynamics`), the flight slice (rotors, controllers, scenarios; read opaquely, the plugin owns its shape) and
 * the entities and materials of every rigid body: what run_flight reads. Unrelated entities and the analysis itself are not part of it.
 * @invariant equal for equal inputs (canonical JSON); different when a body, rotor, controller, scenario, gravity, mass or the geometry of a body changes
 */
export function flightDesignHash(doc: CadDocument): string {
  const dynamics = doc.dynamics ?? null;
  const entityIds = Object.values(dynamics?.bodies ?? {}).flatMap((body) => body.entityIds);
  const entities = entityIds.map((id) => (Object.hasOwn(doc.entities, id) ? doc.entities[id] : null));
  const materialIds = [...new Set(entities.flatMap((entity) => (entity?.materialId === undefined ? [] : [entity.materialId])))].sort();
  const materials = materialIds.map((id) => (Object.hasOwn(doc.materials, id) ? doc.materials[id] : null));
  return hashText(canonicalJson({ units: doc.units, dynamics, flight: Reflect.get(doc, 'flight') ?? null, entities, materials }));
}
