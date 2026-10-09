/**
 * Evaluates a road alignment.
 * @layer domain-aec/civil
 * @pure
 */

import type { Entity } from '@core/model/types';
import type { AlignmentObject } from '@core/model/civil';
import type { CivilContext } from './context';

export function evaluateAlignment(_context: CivilContext, _alignment: AlignmentObject): Entity[] {
  return [];
}
