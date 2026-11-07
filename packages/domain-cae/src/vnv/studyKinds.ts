/** What each refinement kind of a study allows: its level count and the one control that may vary between levels (mixed-kind studies are refused). */

import { canonicalJson } from '@lib/canonicalJson';
import { isRecord } from '@lib/isRecord';

export const REFINEMENTS = ['h', 'dt', 'p'] as const;

/** Level counts per kind: h and dt 3 to 6 (a triplet at least), p exactly the two orders CalculiX has. */
export const levelBounds = (refinement: string): readonly [number, number] => (refinement === 'p' ? [2, 2] : [3, 6]);

export interface KindProblem {
  readonly code: 'VNV_LEVELS_INVALID' | 'VNV_MIXED_REFINEMENT';
  readonly message: string;
}

const without = (controls: unknown, keys: readonly string[]): string =>
  canonicalJson(Object.fromEntries(Object.entries(isRecord(controls) ? controls : {}).filter(([key]) => !keys.includes(key))));

/**
 * Whether the level controls (finest first) fit one refinement kind: h varies only the sizes (`globalSize`, `minSize`, `refinements`), dt varies nothing in the
 * mesh (the step is the control), p varies only the element order (2 then 1).
 * @invariant a study never mixes kinds: a control other than its own differing between levels is VNV_MIXED_REFINEMENT
 * @failure level count outside the kind's bounds -> VNV_LEVELS_INVALID
 */
export function kindProblem(refinement: string, controls: readonly unknown[]): KindProblem | null {
  const [lowest, highest] = levelBounds(refinement);
  if (controls.length < lowest || controls.length > highest)
    return {
      code: 'VNV_LEVELS_INVALID',
      message:
        lowest === highest
          ? `a ${refinement} study has exactly ${lowest} levels, not ${controls.length}`
          : `a ${refinement} study has ${lowest} to ${highest} levels, not ${controls.length}`,
    };
  const varying = refinement === 'h' ? ['globalSize', 'minSize', 'refinements'] : refinement === 'p' ? ['order'] : [];
  const first = without(controls[0], varying);
  if (controls.some((level) => without(level, varying) !== first))
    return {
      code: 'VNV_MIXED_REFINEMENT',
      message: `the levels of a ${refinement} study may differ only in ${refinement === 'h' ? 'their mesh sizes' : refinement === 'p' ? 'their element order' : "their time step (the mesh controls are the case's own)"}: another control differs`,
    };
  if (refinement === 'p') {
    const orders = controls.map((level) => (isRecord(level) ? level['order'] : undefined));
    if (orders[0] !== 2 || orders[1] !== 1)
      return { code: 'VNV_LEVELS_INVALID', message: 'an order study lists order 2 (finest) then order 1' };
  }
  return null;
}
