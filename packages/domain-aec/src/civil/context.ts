/**
 * What a civil evaluator sees: the document being regenerated and the civil model to evaluate.
 * @layer domain-aec/civil
 */

import type { CadDocument } from '@core/model/types';
import type { CivilModel } from '@core/model/civil';
import { fromMm } from '../model';

export interface CivilContext {
  readonly doc: CadDocument;
  readonly civil: CivilModel;
}

/** Annotation text height: 1.5 m on site plans, in document units. */
export function labelHeight(doc: Pick<CadDocument, 'units'>): number {
  return fromMm(doc, 1500);
}
