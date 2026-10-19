// Entities a parameter drives: the `affected` ids of the live history steps whose params read it through an `=expr` (the same
// dependency logic regeneration uses; see stepEntityIds).

import { stepsReading } from '@core/commands/history/dependents';
import { stepEntityIds } from '@ui/panels/stepEntities';
import type { CadDocument, EntityId } from '@core/model/types';

export function entitiesDrivenBy(doc: Pick<CadDocument, 'featureHistory' | 'recipes' | 'entities'>, names: Iterable<string>): EntityId[] {
  const ids = new Set<EntityId>();
  for (const step of stepsReading(doc.featureHistory, new Set(names), doc)) {
    for (const id of stepEntityIds(step, doc.entities)) ids.add(id);
  }
  return [...ids];
}
