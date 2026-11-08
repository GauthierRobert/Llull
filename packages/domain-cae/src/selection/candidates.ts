/** Candidate materials of a selection (PHY-12): document materials or 06 lamina materials with a layup; one validation for every command. */

import type { CadDocument } from '@core/model/types';
import { layupRequired, unknownCandidates, type Layup } from './layups';

export interface CandidateProblem {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
  readonly path: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** The layup of a candidate, when one is given (own keys only). */
export const layupOf = (layups: Readonly<Record<string, Layup>> | undefined, id: string): Layup | undefined =>
  layups !== undefined && Object.hasOwn(layups, id) ? layups[id] : undefined;

/**
 * The first problem of a candidate list as a refusal, or null: an unknown id, a layup for an id that is not a candidate, a lamina material without a layup.
 * @invariant a lamina candidate is never compared as an isotropic material (its E1 is not E)
 */
export function candidateProblem(
  doc: CadDocument,
  ids: readonly string[],
  layups: Readonly<Record<string, Layup>> | undefined,
): CandidateProblem | null {
  const unknown = unknownCandidates(doc, ids);
  if (unknown.length > 0)
    return {
      code: 'SEL_MATERIAL_NOT_FOUND',
      message: `no material ${unknown.map((id) => `'${id}'`).join(', ')}`,
      ids: unknown,
      path: 'materials',
      detail: { known: Object.keys(doc.materials) },
    };
  const stray = Object.keys(layups ?? {}).filter((id) => !ids.includes(id));
  if (stray.length > 0)
    return {
      code: 'SEL_PARAMS_INVALID',
      message: `layups for ${stray.map((id) => `'${id}'`).join(', ')}, which are not candidates`,
      ids: stray,
      path: 'layups',
    };
  const missing = layupRequired(doc, ids, layups);
  return missing.length === 0
    ? null
    : {
        code: 'SEL_LAYUP_REQUIRED',
        message: `${missing.map((id) => `'${id}'`).join(', ')} is a lamina material: name its layup in layups (a lamina E1 is not an isotropic E)`,
        ids: missing,
        path: 'layups',
      };
}
