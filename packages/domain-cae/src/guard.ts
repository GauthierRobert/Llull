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
