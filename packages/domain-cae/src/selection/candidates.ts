/** Candidate materials of a selection (PHY-12): document materials or 06 lamina materials with a layup; one validation for every command. */

import type { CadDocument } from '@core/model/types';
import { MAX_CANDIDATES } from './inputs';
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

/**
 * The candidate ids of a request: the listed ones (duplicates removed) or every material imported from a library (ascending id), capped at MAX_CANDIDATES
 * after the library is resolved; a refusal for an absent library or too many candidates.
 */
export function candidateList(doc: CadDocument, materials: readonly string[] | { readonly library: string }): string[] | CandidateProblem {
  let ids: string[];
  if ('library' in materials) {
    const { library } = materials;
    if (!Object.hasOwn(doc.materialLibraries ?? {}, library))
      return {
        code: 'SEL_MATERIAL_NOT_FOUND',
        message: `no material library '${library}' in the document`,
        ids: [],
        path: 'materials.library',
      };
    ids = Object.values(doc.materials)
      .filter((material) => material.record?.libraryRef?.libraryId === library)
      .map((material) => material.name)
      .sort();
  } else ids = [...new Set(materials)];
  return ids.length > MAX_CANDIDATES
    ? { code: 'SEL_PARAMS_INVALID', message: `${ids.length} candidates: at most ${MAX_CANDIDATES} per call`, ids: [], path: 'materials' }
    : ids;
}
