/**
 * Constructive vs evaluated partition of a `CadDocument` (architecture L8, MG4.1).
 *
 * @layer core/model
 * @invariant `withEvaluated(definitionOf(d), evaluatedOf(d))` deep-equals `d`
 * @invariant the definition is the source of truth; evaluated geometry is derivable from it
 *   (replaying `featureHistory`, regenerating `building`) and may be dropped from storage
 */

import type { CadDocument } from './types';
import { documentExtensions } from '../plugins/host';

/** Keys holding evaluated geometry (the render/export cache). */
export const EVALUATED_KEYS = ['entities', 'order'] as const;

export type EvaluatedKey = (typeof EVALUATED_KEYS)[number];
export type EvaluatedModel = Pick<CadDocument, EvaluatedKey>;
export type DocumentDefinition = Omit<CadDocument, EvaluatedKey>;

export function definitionOf(doc: CadDocument): DocumentDefinition {
  const definition: Partial<CadDocument> = { ...doc };
  for (const key of EVALUATED_KEYS) delete definition[key];
  return definition as DocumentDefinition;
}

export function evaluatedOf(doc: CadDocument): EvaluatedModel {
  return { entities: doc.entities, order: doc.order };
}

export function withEvaluated(
  definition: DocumentDefinition,
  evaluated: EvaluatedModel,
): CadDocument {
  return { ...definition, entities: evaluated.entities, order: evaluated.order };
}

/**
 * Entity ids regenerated from the definition by an installed plugin's pure deriver (today: the
 * building plugin via `regenerateBuilding`). Persistence omits these and re-derives them on load.
 */
export function derivedEntityIds(doc: CadDocument): Set<string> {
  const ids = new Set<string>();
  for (const extension of documentExtensions())
    for (const id of extension.derivedEntityIds(doc)) ids.add(id);
  return ids;
}
