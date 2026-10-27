/** Shared tail of the cage topology commands: validate the edited cage, re-pair its symmetry, build the command result. */

import type { CadDocument, SubdivisionEntity } from '../../model/types';
import type { CageSymmetry } from '../../model/subdivisionCage';
import type { CommandResult } from '../types';
import { changed } from '../noop';
import { replaceEntity } from '../entity/entityOps';
import { cageProblem } from '../../geometry/subdivision';
import type { CageState } from '../../geometry/subd/cageState';
import { withCageState } from '../../geometry/subd/cageState';
import { isOpenCage } from '../../geometry/subd/boundary';
import { pairVertices, symmetricTopologyProblem } from '../../geometry/subd/symmetry';
import { buildTopology } from '../../geometry/subd/topology';
import { dirRejection } from './codes';
import { MAX_CAGE_VERTICES, MAX_REFINED_QUADS, cageData, cageText } from './shared';

/**
 * The edited entity, or the refusal: the cage must stay valid and within the size cap, and a symmetric cage must stay symmetric (its
 * vertices are re-paired within the stored tolerance and every face needs a mirror face).
 */
export function finishedCage(
  doc: CadDocument,
  command: string,
  entity: SubdivisionEntity,
  state: CageState,
): SubdivisionEntity | CommandResult {
  const reject = (code: string, message: string): CommandResult => dirRejection(doc, command, code, message, [entity.id]);
  if (state.vertices.length > MAX_CAGE_VERTICES)
    return reject('DIR_CAGE_TOO_LARGE', `the result would have ${state.vertices.length} vertices (max ${MAX_CAGE_VERTICES})`);
  if (state.faces.length * 4 ** entity.levels > MAX_REFINED_QUADS)
    return reject(
      'DIR_CAGE_TOO_LARGE',
      `the result would have ${state.faces.length} faces, which refine to over ${MAX_REFINED_QUADS} quads at ${entity.levels} levels`,
    );
  let symmetry: CageSymmetry | undefined;
  if (entity.symmetry !== undefined) {
    const pairing = pairVertices(state.vertices, entity.symmetry.planes, entity.symmetry.tolerance);
    symmetry = { ...entity.symmetry, partners: pairing.partners };
    if (pairing.unpaired.length > 0 || symmetricTopologyProblem(state.faces, symmetry).length > 0)
      return reject('DIR_SYMMETRY_BROKEN', 'the result would not be mirror-symmetric');
  }
  const rebuilt = withCageState(entity, state, symmetry);
  const problem = cageProblem(rebuilt);
  if (problem !== null) return reject('DIR_CAGE_INVALID', `the result is not a valid cage: ${problem}`);
  // `boundary` is present only while the cage is open
  if (rebuilt.boundary === undefined || !isOpenCage(buildTopology(state.vertices.length, state.faces))) {
    const { boundary, ...closed } = rebuilt;
    void boundary;
    return closed;
  }
  return rebuilt;
}

export const isCommandResult = (value: SubdivisionEntity | CommandResult): value is CommandResult => 'summary' in value;

/** The mutating result of a topology edit: the new document, a factual summary and the created element ids as `data`. */
export function topologyResult(
  doc: CadDocument,
  command: string,
  updated: SubdivisionEntity,
  text: string,
  extra: Record<string, unknown>,
  record: Record<string, unknown> | null,
): CommandResult {
  return {
    ...changed(replaceEntity(doc, updated), `${command}: '${updated.id}' — ${text}; now ${cageText(updated, updated.levels)}.`, [
      updated.id,
    ]),
    data: { ...cageData(updated), ...extra },
    ...(record === null ? {} : { recordExtras: record }),
  };
}
