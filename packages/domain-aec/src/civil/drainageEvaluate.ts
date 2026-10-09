/**
 * Evaluates drainage structures and pipes.
 * @layer domain-aec/civil
 * @pure
 */

import type { Entity } from '@core/model/types';
import type { ManholeObject, PipeObject } from '@core/model/civil';
import type { CivilContext } from './context';

export function evaluateManhole(_context: CivilContext, _manhole: ManholeObject): Entity[] {
  return [];
}

export function evaluatePipe(_context: CivilContext, _pipe: PipeObject): Entity[] {
  return [];
}
