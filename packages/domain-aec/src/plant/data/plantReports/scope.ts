/** The plant objects a report covers: the objects of a hierarchy subtree (or all), in natural tag order. */

import { resolveNode, subtreeIds } from '../hierarchy';
import { getPlantData, type PlantObject } from '../model';
import { naturalCompare } from '../naturalSort';
import type { CadDocument } from '@core/model/types';

export type ScopeOutcome =
  | { readonly ok: true; readonly objects: readonly PlantObject[] }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly path: string };

export function objectsInScope(doc: CadDocument, hierarchy: string | undefined): ScopeOutcome {
  const data = getPlantData(doc);
  let scope: Set<string> | null = null;
  if (hierarchy !== undefined) {
    const node = resolveNode(data, hierarchy);
    if (node === null || node === 'ambiguous')
      return { ok: false, code: 'DAT_HIERARCHY_UNKNOWN', message: `no (or an ambiguous) hierarchy node "${hierarchy}"`, path: 'hierarchy' };
    scope = subtreeIds(data, node.id);
  }
  const objects = data.objectOrder.flatMap((id) => {
    const object = data.objects[id];
    return object === undefined || (scope !== null && !scope.has(object.hierarchyId)) ? [] : [object];
  });
  return { ok: true, objects: objects.sort((a, b) => naturalCompare(a.tag, b.tag) || naturalCompare(a.id, b.id)) };
}

export const isUnverified = (object: PlantObject): boolean =>
  Object.values(object.provenance ?? {}).some((provenance) => provenance.unverified === true);
