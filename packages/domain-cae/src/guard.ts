/** Derivation guard: an entity an analysis still uses cannot disappear (the saved file would reference a missing part). */

import type { DerivationGuard } from '@core/commands/derivation';
import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';

function referencedEntities(analysisCase: AnalysisCase): Set<string> {
  const ids = new Set(Object.keys(analysisCase.parts));
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value !== null && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) {
        if (key === 'entityId' && typeof item === 'string') ids.add(item);
        else collect(item);
      }
  };
  collect([analysisCase.constraints, analysisCase.loads, analysisCase.mesh, analysisCase.thermal, analysisCase.thermomech]);
  return ids;
}

/**
 * @invariant a command may not remove (or replace under another id) an entity that an analysis case still references
 */
export const analysisReferenceGuard: DerivationGuard = {
  domain: 'cae',
  check(previous: CadDocument, next: CadDocument): string | null {
    if (next.analysis === undefined) return null;
    for (const analysisCase of Object.values(next.analysis.cases))
      for (const id of referencedEntities(analysisCase))
        if (Object.hasOwn(previous.entities, id) && !Object.hasOwn(next.entities, id))
          return `entity '${id}' is used by analysis '${analysisCase.id}'; delete_analysis (or remove it from the analysis) first`;
    return null;
  },
};

function durabilityModelRefs(doc: CadDocument): Array<{ owner: string; materialId: string; modelId: string }> {
  const durability = doc.analysis?.durability;
  if (durability === undefined) return [];
  const fatigue = Object.values(durability.fatigueCases).flatMap((fatigueCase) =>
    [fatigueCase.material.modelId, fatigueCase.material.cyclicModelId]
      .filter((modelId): modelId is string => modelId !== undefined)
      .map((modelId) => ({ owner: `fatigue case '${fatigueCase.id}'`, materialId: fatigueCase.material.recordId, modelId })),
  );
  const growth = Object.values(durability.crackGrowthCases).flatMap((growthCase) =>
    [growthCase.material.growthModelId, growthCase.material.toughnessModelId].map((modelId) => ({
      owner: `crack growth case '${growthCase.id}'`,
      materialId: growthCase.material.recordId,
      modelId,
    })),
  );
  return [...fatigue, ...growth];
}

const hasModel = (doc: CadDocument, materialId: string, modelId: string): boolean =>
  Object.hasOwn(doc.materials, materialId) && (doc.materials[materialId]?.materialModels ?? []).some((model) => model.id === modelId);

/**
 * @invariant a command may not remove a material or material model that a fatigue / crack growth case still references
 */
export const durabilityReferenceGuard: DerivationGuard = {
  domain: 'cae',
  check(previous: CadDocument, next: CadDocument): string | null {
    for (const ref of durabilityModelRefs(next))
      if (hasModel(previous, ref.materialId, ref.modelId) && !hasModel(next, ref.materialId, ref.modelId))
        return `material model '${ref.modelId}' of '${ref.materialId}' is used by ${ref.owner}; delete or update that case first`;
    return null;
  },
};
