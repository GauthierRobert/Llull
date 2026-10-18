// Entities a history step produced: its recorded `affected` ids, else (steps inserted by hand carry none) the entities whose
// step-scoped id `<prefix>-<step>.<k>` names the step.

import type { CadDocument, EntityId, FeatureStep } from '@core/model/types';

export function stepEntityIds(step: FeatureStep, entities: CadDocument['entities']): EntityId[] {
  const recorded = (step.affected ?? []).filter((id) => Object.hasOwn(entities, id));
  if (recorded.length > 0) return recorded;
  const stepNumber = /^step-(\d+)$/.exec(step.id)?.[1];
  if (stepNumber === undefined) return [];
  return Object.keys(entities).filter((id) => new RegExp(`-${stepNumber}\\.\\d+$`).test(id));
}
