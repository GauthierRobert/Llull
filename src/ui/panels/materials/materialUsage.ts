// Which entities use each material and (read-only mass_properties query) how much they weigh together.

import { execute } from '@core/commands/registry';
import type { CadDocument, EntityId } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { significantNumber } from '@lib/compactNumber';

/** Beyond this many solids per material the mass is not summed in the panel (each query integrates a shape). */
const MASS_QUERY_LIMIT = 40;

export function entityIdsByMaterial(doc: Pick<CadDocument, 'entities' | 'order'>): Map<string, EntityId[]> {
  const byMaterial = new Map<string, EntityId[]>();
  for (const id of doc.order) {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    if (entity?.materialId === undefined) continue;
    byMaterial.set(entity.materialId, [...(byMaterial.get(entity.materialId) ?? []), id]);
  }
  return byMaterial;
}

/** Total mass in grams of the solids among `ids`; null when none has a known mass or there are too many to measure. */
export function totalMassG(doc: CadDocument, ids: readonly EntityId[]): number | null {
  if (ids.length > MASS_QUERY_LIMIT) return null;
  let total = 0;
  let measured = false;
  for (const entityId of ids) {
    const data = execute(doc, 'mass_properties', { entityId }).data;
    const massG = isRecord(data) ? data['massG'] : undefined;
    if (typeof massG === 'number') {
      total += massG;
      measured = true;
    }
  }
  return measured ? total : null;
}

/** "12.4 kg" / "830 g" */
export function formatMass(massG: number): string {
  return massG >= 1000 ? `${significantNumber(massG / 1000, 3)} kg` : `${significantNumber(massG, 3)} g`;
}
