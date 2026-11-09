/** The hash that binds a reviewer's acceptance to the exact reliability model it was given (everything a limit state's result depends on). */

import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { limitStateOf, reliabilityOf } from './model';

/**
 * SHA-256 over the limit state, every random variable, the correlation, the responses and everything a response reads (parameters, materials, entities); null for an unknown limit state.
 * @invariant any change that can move the result of a study of this limit state changes the hash; acceptances and other limit states do not
 */
export function limitStateModelHash(doc: CadDocument, limitState: string): string | null {
  const found = limitStateOf(doc, limitState);
  if (found === undefined) return null;
  const { variables, variableOrder, correlation, responses, responseOrder } = reliabilityOf(doc);
  const { entities, order, materials, parameters } = doc;
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
