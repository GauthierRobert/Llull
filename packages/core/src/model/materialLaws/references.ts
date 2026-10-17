/** Property models referenced by a law, and the reasons a model's values are unverified (PHY-02 §5.9). */

import { lawIssues } from '../materialLawCatalog';
import { UNVERIFIED_BASES } from '../propertyModel';
import { modelUnverifiedReasons, type PropertyRecord } from '../propertyModelEval';
import type { MaterialModel } from '../materialModel';

/** Ids of the `{ propertyModelId }` parameters inside a law, in document order without duplicates. */
function referencedPropertyModels(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (typeof node === 'object' && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        if (key === 'propertyModelId' && typeof child === 'string') found.push(child);
        else walk(child);
      }
    }
  };
  walk(value);
  return [...new Set(found)];
}

/**
 * Why a material model is unverified: unverified basis, a fit without data provenance or without reviewer acceptance, a referenced property
 * model that is itself unverified.
 */
export function modelUnverifiedReasonsOf(model: MaterialModel, record: PropertyRecord): string[] {
  const reasons: string[] = [];
  if (UNVERIFIED_BASES.has(model.basis)) reasons.push(`basis ${model.basis}`);
  if (model.fit !== undefined && model.fit.dataProvenance === undefined) reasons.push('fit without data provenance');
  if (model.fit !== undefined && model.reviewedBy === undefined) reasons.push('fit not reviewed');
  for (const id of referencedPropertyModels(model.model)) {
    const property = record.propertyModels?.find((candidate) => candidate.id === id);
    if (property !== undefined) reasons.push(...modelUnverifiedReasons(property).map((reason) => `property model '${id}': ${reason}`));
  }
  return reasons;
}

/** A fitted model not accepted by a reviewer (human gate) needs review before use in a margin or certification. */
export const needsReview = (model: MaterialModel): boolean => model.fit !== undefined && model.reviewedBy === undefined;

/** Material models that read the property model `id`, and the first error they raise against the given property models. */
export function materialModelsReading(
  name: string,
  id: string,
  materialModels: readonly MaterialModel[],
  propertyModels: PropertyRecord['propertyModels'],
): { readonly readers: readonly string[]; readonly broken: { readonly modelId: string; readonly message: string } | null } {
  const readers = materialModels.filter((model) => referencedPropertyModels(model.model).includes(id));
  for (const model of readers) {
    const issue = lawIssues(model.model, {
      record: { name, ...(propertyModels !== undefined ? { propertyModels } : {}) },
      ...(model.validity !== undefined ? { validity: model.validity } : {}),
    }).find((candidate) => candidate.severity === 'error');
    if (issue !== undefined)
      return {
        readers: readers.map((r) => r.id),
        broken: { modelId: model.id, message: `${issue.code} at ${issue.path}: ${issue.message}` },
      };
  }
  return { readers: readers.map((r) => r.id), broken: null };
}
