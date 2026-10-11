/**
 * Civil regeneration: evaluates every civil object into entities and replaces the stale ones.
 * @layer domain-aec/civil
 */

import type { CadDocument, Entity } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import type { CivilModel, CivilObject } from '@core/model/civil';
import { CIVIL_LAYER_COLOR } from './entities';
import { regenerateOwned } from '../derived';
import { civilAffected } from './model';
import { evaluatePointGroup, evaluateSurface } from './surfaceEvaluate';
import { evaluatePlatform } from './platformEvaluate';
import { evaluateAlignment } from './alignmentEvaluate';
import { evaluateManhole, evaluatePipe } from './drainageEvaluate';
import type { CivilContext } from './context';

function evaluateObject(context: CivilContext, object: CivilObject): Entity[] {
  switch (object.category) {
    case 'pointGroup':
      return evaluatePointGroup(context, object);
    case 'surface':
      return evaluateSurface(context, object);
    case 'platform':
      return evaluatePlatform(context, object);
    case 'alignment':
      return evaluateAlignment(context, object);
    case 'manhole':
      return evaluateManhole(context, object);
    case 'pipe':
      return evaluatePipe(context, object);
  }
}

/**
 * Replaces all previously evaluated civil entities with a fresh evaluation of `civil`.
 * @pure
 * @returns the new document; each object's `entityIds` lists the entities generated for it
 */
export function regenerateCivil(doc: CadDocument, civil: CivilModel): CadDocument {
  const context: CivilContext = { doc, civil };
  const { parts, owners } = regenerateOwned(
    doc,
    Object.values(doc.civil?.objects ?? {}),
    civil.order.flatMap((id) => civil.objects[id] ?? []),
    (object) => evaluateObject(context, object),
    CIVIL_LAYER_COLOR,
  );
  return { ...doc, ...parts, civil: { ...civil, objects: owners } };
}

/** Regenerates `doc` from the edited model; `affected` = `objectIds` then the entities generated. */
export function commitCivil(
  doc: CadDocument,
  model: CivilModel,
  objectIds: ReadonlyArray<string>,
  summary: string,
  data?: Record<string, unknown>,
): CommandResult {
  const document = regenerateCivil(doc, model);
  const affected = civilAffected(document, objectIds);
  return data === undefined
    ? { document, summary, affected }
    : { document, summary, affected, data };
}
