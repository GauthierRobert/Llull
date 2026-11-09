/** Derivation guard: a solid or material that a coating assignment or bond path still names cannot disappear (the slice would dangle). */

import type { DerivationGuard } from '@core/commands/derivation';
import type { CadDocument } from '@core/model/types';

interface Reference {
  readonly kind: 'entities' | 'materials';
  readonly id: string;
  readonly owner: string;
}

/** Everything the slice references. */
function references(doc: CadDocument): Reference[] {
  const found: Reference[] = [];
  for (const item of Object.values(doc.electroOptical?.coatings ?? {})) {
    const owner = `coating assignment '${item.id}'`;
    found.push({ kind: 'entities', id: item.entityId, owner }, { kind: 'materials', id: item.coating, owner });
  }
  for (const path of Object.values(doc.electroOptical?.bondPaths ?? {})) {
    const owner = `bond path '${path.id}'`;
    found.push({ kind: 'entities', id: path.from, owner }, { kind: 'entities', id: path.to, owner });
    for (const element of path.elements) {
      if (element.kind === 'strap') found.push({ kind: 'materials', id: element.material, owner });
      else for (const id of element.interfaces ?? []) found.push({ kind: 'entities', id, owner });
    }
  }
  return found;
}

/**
 * @invariant a command may not remove an entity or material that a coating assignment or bond path still references
 */
export const electroOpticalReferenceGuard: DerivationGuard = {
  domain: 'electro-optical',
  check(previous: CadDocument, next: CadDocument): string | null {
    for (const { kind, id, owner } of references(next))
      if (Object.hasOwn(previous[kind], id) && !Object.hasOwn(next[kind], id))
        return `${kind === 'entities' ? 'entity' : 'material'} '${id}' is used by ${owner}; delete it (remove_surface_coating / delete_bond_path) first`;
    return null;
  },
};
