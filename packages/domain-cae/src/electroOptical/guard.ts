/** Derivation guard: a solid or material that a coating assignment or bond path still names cannot disappear (the slice would dangle). */

import type { DerivationGuard, GuardContext } from '@core/commands/derivation';
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
  for (const label of Object.values(doc.electroOptical?.zones ?? {}))
    found.push({ kind: 'entities', id: label.entityId, owner: `lightning zone label '${label.id}'` });
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
 * @invariant a command may not remove an entity or material that a coating assignment, bond path or lightning zone label still references
 * @invariant never refuses a step re-run by history replay; the net result of a history meta-command is still checked (L8)
 * @invariant known limit: instantiate_recipe re-runs its inner steps without the replaying flag (core recipes.ts), so a recipe step re-run by
 *   replay is still guarded
 */
export const electroOpticalReferenceGuard: DerivationGuard = {
  domain: 'electro-optical',
  check(previous: CadDocument, next: CadDocument, _commandName: string, context?: GuardContext): string | null {
    if (context?.replaying === true) return null;
    for (const { kind, id, owner } of references(next))
      if (Object.hasOwn(previous[kind], id) && !Object.hasOwn(next[kind], id))
        return `${kind === 'entities' ? 'entity' : 'material'} '${id}' is used by ${owner}; delete it (remove_surface_coating / delete_bond_path / remove_lightning_zone) first`;
    return null;
  },
};
