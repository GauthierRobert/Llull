/** Lookups in the plant hierarchy (plant 08 DAT §3, TR-DAT-09): references by id, code or `S1/P1/U10` path, ancestry, subtrees, tag scopes. */

import { HIERARCHY_KINDS, type HierarchyKind, type HierarchyNode, type PlantDataModel, type TagScope } from './model';

export const kindRank = (kind: HierarchyKind): number => HIERARCHY_KINDS.indexOf(kind);

/** Nodes from the root down to `id` (empty for an unknown id; a broken parent chain stops at the break). */
export function ancestry(data: PlantDataModel, id: string): HierarchyNode[] {
  const chain: HierarchyNode[] = [];
  let current = data.hierarchy[id];
  while (current !== undefined && chain.length <= HIERARCHY_KINDS.length) {
    chain.unshift(current);
    current = current.parentId === null ? undefined : data.hierarchy[current.parentId];
  }
  return chain;
}

export const pathOf = (data: PlantDataModel, id: string): string =>
  ancestry(data, id)
    .map((node) => node.code)
    .join('/');

/** The node `reference` names: its id, a `S1/P1/U10` path from a root, or a code used by exactly one node. `ambiguous` lists nothing: use the path. */
export function resolveNode(data: PlantDataModel, reference: string): HierarchyNode | 'ambiguous' | null {
  const byId = data.hierarchy[reference];
  if (byId !== undefined) return byId;
  const nodes = data.hierarchyOrder.flatMap((id) => data.hierarchy[id] ?? []);
  if (reference.includes('/')) return nodes.find((node) => pathOf(data, node.id) === reference) ?? null;
  const byCode = nodes.filter((node) => node.code === reference);
  if (byCode.length > 1) return 'ambiguous';
  return byCode[0] ?? null;
}

/** `rootId` and every node below it. */
export function subtreeIds(data: PlantDataModel, rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of data.hierarchyOrder) {
      const node = data.hierarchy[id];
      if (node?.parentId != null && ids.has(node.parentId) && !ids.has(id)) {
        ids.add(id);
        grew = true;
      }
    }
  }
  return ids;
}

/** Key of the tag scope of an object placed at `hierarchyId`: the ancestor (or self) of kind `scope`; `project` is one scope for everything; an object above that level is its own scope. */
export function scopeKey(data: PlantDataModel, hierarchyId: string, scope: TagScope): string {
  if (scope === 'project') return '*';
  const chain = ancestry(data, hierarchyId);
  return (chain.find((node) => node.kind === scope) ?? chain.at(-1))?.id ?? hierarchyId;
}
