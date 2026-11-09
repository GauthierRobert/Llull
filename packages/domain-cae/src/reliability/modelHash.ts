/** The hash that binds a reviewer's acceptance to the exact reliability model it was given (everything a limit state's result depends on). */

import { derivedEntityIds } from '@core/plugins/host';
import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { limitStateOf, reliabilityOf } from './model';

/**
 * The entities as constructed: plugin-derived entities are left out (re-derived on load) and a kernel solid keeps its exact `brep` recipe but not the
 * tessellated `mesh` it evaluates to (so the hash does not depend on the machine's kernel arithmetic); imported meshes keep their triangles (input).
 */
function constructiveEntities(doc: CadDocument): Record<string, unknown> {
  const derived = derivedEntityIds(doc);
  return Object.fromEntries(
    Object.entries(doc.entities).flatMap(([id, entity]): Array<[string, unknown]> => {
      if (derived.has(id)) return [];
      if (entity.kind !== 'mesh' || entity.brep === undefined) return [[id, entity]];
      const { mesh, ...recipe } = entity;
      void mesh;
      return [[id, recipe]];
    }),
  );
}

/**
 * SHA-256 over the limit state, every random variable, the correlation, the responses and everything a response reads (parameters, materials, constructive entities); null for an unknown limit state.
 * @invariant any change that can move the result of a study of this limit state changes the hash; acceptances and other limit states do not
 */
export function limitStateModelHash(doc: CadDocument, limitState: string): string | null {
  const found = limitStateOf(doc, limitState);
  if (found === undefined) return null;
  const { variables, variableOrder, correlation, responses, responseOrder } = reliabilityOf(doc);
  const { order, materials, parameters } = doc;
  const entities = constructiveEntities(doc);
  return sha256Hex(
    canonicalJson({
      limitState: found,
      variables,
      variableOrder,
      correlation,
      responses,
      responseOrder,
      parameters,
      materials,
      entities,
      order,
    }),
  );
}
