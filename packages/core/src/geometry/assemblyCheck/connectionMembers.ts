/**
 * Members of a connection group, resolved against the document at check time (patterns, layers and groups stay live).
 * @invariant ids come back in document order, 3D only, without duplicates; `stale` lists what no longer exists (never thrown)
 */

import type { CadDocument } from '../../model/types';
import { is3D } from '../../model/types';
import type { ConnectionMembers } from '../../model/prototype';

export interface ResolvedMembers {
  /** Live 3D entity / instance ids in document order. */
  readonly ids: string[];
  /** Referenced ids (entity, pattern seed, layer, group) that no longer exist. */
  readonly stale: string[];
}

export function resolveMembers(doc: CadDocument, members: ConnectionMembers): ResolvedMembers {
  const live = (id: string): boolean => {
    const entity = doc.entities[id];
    return entity !== undefined && is3D(entity);
  };
  if ('ids' in members) {
    const wanted = new Set(members.ids);
    return { ids: doc.order.filter((id) => wanted.has(id) && live(id)), stale: [...wanted].filter((id) => doc.entities[id] === undefined) };
  }
  if ('patternOf' in members) {
    const seed = members.patternOf;
    if (doc.entities[seed] === undefined) return { ids: [], stale: [seed] };
    return { ids: doc.order.filter((id) => live(id) && (id === seed || doc.entities[id]?.patternSourceId === seed)), stale: [] };
  }
  if ('layerId' in members) {
    const layer = members.layerId;
    if (doc.layers[layer] === undefined) return { ids: [], stale: [layer] };
    return { ids: doc.order.filter((id) => live(id) && doc.entities[id]?.layerId === layer), stale: [] };
  }
  const group = doc.groups[members.groupId];
  if (group === undefined) return { ids: [], stale: [members.groupId] };
  const wanted = new Set(group.memberIds);
  return {
    ids: doc.order.filter((id) => wanted.has(id) && live(id)),
    stale: group.memberIds.filter((id) => doc.entities[id] === undefined),
  };
}
