/** Derivation guard: a solid or material that a surface system, isolation or galvanic-group entry still names cannot disappear (the slice would dangle). */

import { type DerivationGuard, type GuardContext, type GuardRefusal, WHOLE_DOCUMENT_REPLACEMENTS } from '@core/commands/derivation';
import { commandError } from '@core/commands/noop';
import type { CadDocument } from '@core/model/types';
import { remediationOfCor } from './codes';
import { corrosionOf } from './model';
import { rootOf } from './resolve';

/** The corrosion entry that holds a reference. */
export interface CorrosionEntry {
  readonly kind: 'surface_system' | 'isolation' | 'galvanic_group';
  readonly id: string;
}

interface Reference {
  readonly entry: CorrosionEntry;
  readonly kind: 'entities' | 'materials';
  readonly id: string;
  readonly owner: string;
  readonly remedy: string;
}

/** Everything the slice references by id (an instance child id references its instance). Acceptances are not references: they go orphaned and the check reports them. */
export function corrosionReferences(doc: CadDocument): Reference[] {
  const model = corrosionOf(doc);
  const found: Reference[] = [];
  for (const system of Object.values(model.surfaceSystems))
    for (const id of system.entityIds)
      found.push({
        entry: { kind: 'surface_system', id: system.id },
        kind: 'entities',
        id: rootOf(id),
        owner: `surface system '${system.id}'`,
        remedy: `assign_surface_system { entityIds: ['${id}'], layers: [{ class: 'none' }] } or remove_surface_system '${system.id}'`,
      });
  for (const isolation of Object.values(model.isolations))
    for (const id of isolation.pair ?? (isolation.entityId === undefined ? [] : [isolation.entityId]))
      found.push({
        entry: { kind: 'isolation', id: isolation.id },
        kind: 'entities',
        id: rootOf(id),
        owner: `isolation '${isolation.id}'`,
        remedy: `remove_isolation '${isolation.id}'`,
      });
  for (const material of Object.keys(model.materials))
    found.push({
      entry: { kind: 'galvanic_group', id: material },
      kind: 'materials',
      id: material,
      owner: `the galvanic group of '${material}'`,
      remedy: `remove_galvanic_group '${material}'`,
    });
  return found;
}

const referenceKey = (reference: Reference): string => `${reference.entry.kind}:${reference.entry.id}>${reference.kind}:${reference.id}`;

/**
 * @invariant a command may not remove an entity or material that a surface system, declared isolation or galvanic-group entry of the INPUT
 *   document still references (and the result keeps); refusal COR_REFERENCE_IN_USE
 * @invariant never refuses a step re-run by history replay; the net result of a history meta-command is still checked (L8); never refuses a
 *   whole-document replacement (WHOLE_DOCUMENT_REPLACEMENTS)
 * @invariant known limit: instantiate_recipe re-runs its inner steps without the replaying flag (core recipes.ts), so a recipe step re-run by
 *   replay is still guarded
 */
export const corrosionReferenceGuard: DerivationGuard = {
  domain: 'corrosion',
  check(previous: CadDocument, next: CadDocument, commandName: string, context?: GuardContext): GuardRefusal | null {
    if (context?.replaying === true || WHOLE_DOCUMENT_REPLACEMENTS.has(commandName)) return null;
    const before = new Set(corrosionReferences(previous).map(referenceKey));
    for (const reference of corrosionReferences(next)) {
      const { kind, id, owner, remedy } = reference;
      if (before.has(referenceKey(reference)) && Object.hasOwn(previous[kind], id) && !Object.hasOwn(next[kind], id))
        return {
          reason: `${kind === 'entities' ? 'entity' : 'material'} '${id}' is used by ${owner}; ${remedy} first`,
          error: commandError('COR_REFERENCE_IN_USE', remediationOfCor('COR_REFERENCE_IN_USE'), [id]),
        };
    }
    return null;
  },
};
