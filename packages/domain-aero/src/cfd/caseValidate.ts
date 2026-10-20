/** Semantic validation of a whole `CfdCase` against the document (shared by cfd_create_case, cfd_update_case, cfd_set_boundary). */

import type { CadDocument, Vec3 } from '@core/model/types';
import type { CfdBoundaryTag, CfdCase } from '@core/model/cfd';
import { axesAreIndependent } from './frame';
import { resolveFlow } from './regime';

export interface CaseProblem {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
  readonly path: string;
}

export const MIN_CELLS_PER_LENGTH = 8;
export const MAX_CELLS_PER_LENGTH = 2048;

const problem = (code: string, message: string, path: string, ids: readonly string[] = []): CaseProblem => ({ code, message, ids, path });
const finiteVec = (v: Vec3): boolean => v.length === 3 && v.every(Number.isFinite);
const exists = (doc: CadDocument, id: string): boolean => Object.hasOwn(doc.entities, id);

/** Two tags conflict when they overlap (same entity, a shared face or a whole-entity tag) with different kinds. */
export function tagsConflict(a: CfdBoundaryTag, b: CfdBoundaryTag): boolean {
  if (a.entityId !== b.entityId || a.kind === b.kind) return false;
  if (a.faceRefs === undefined || b.faceRefs === undefined) return true;
  const faces = b.faceRefs;
  return a.faceRefs.some((ref) => faces.includes(ref));
}

function boundaryProblem(tags: readonly CfdBoundaryTag[]): CaseProblem | null {
  for (let i = 0; i < tags.length; i++)
    for (let j = i + 1; j < tags.length; j++) {
      const a = tags[i];
      const b = tags[j];
      if (a !== undefined && b !== undefined && tagsConflict(a, b))
        return problem('CFD_BOUNDARY_CONFLICT', `entity ${a.entityId} is tagged ${a.kind} and ${b.kind}`, 'boundaries', [a.entityId]);
    }
  return null;
}

function entityProblem(doc: CadDocument, c: CfdCase, tolerated: readonly string[]): CaseProblem | null {
  const missing = [...c.entityIds, ...c.excludedEntityIds, ...c.boundaries.map((tag) => tag.entityId)].filter(
    (id) => !exists(doc, id) && !tolerated.includes(id),
  );
  if (missing.length > 0)
    return problem('CFD_ENTITY_NOT_FOUND', `no entity ${[...new Set(missing)].join(', ')}`, 'entityIds', [...new Set(missing)]);
  const outside = c.boundaries.filter((tag) => !c.entityIds.includes(tag.entityId));
  if (outside.length > 0)
    return problem(
      'CFD_ENTITY_NOT_FOUND',
      `boundary entity ${outside.map((tag) => tag.entityId).join(', ')} is not in entityIds of case ${c.id}`,
      'boundaries',
      outside.map((tag) => tag.entityId),
    );
  return null;
}

function numberProblem(c: CfdCase): CaseProblem | null {
  const { freestream, reference, domain } = c;
  if (!(Math.abs(freestream.alphaDeg) < 90 && Math.abs(freestream.betaDeg) < 90))
    return problem('CFD_PARAM_INVALID', 'alphaDeg and betaDeg must be within (-90, 90)', 'freestream');
  if (!axesAreIndependent(c.flowAxis, c.upAxis) || !finiteVec(c.flowAxis) || !finiteVec(c.upAxis))
    return problem('CFD_PARAM_INVALID', 'flowAxis and upAxis must be finite, non-zero and not parallel', 'flowAxis');
  if (!(reference.areaM2 > 0 && reference.lengthM > 0) || !finiteVec(reference.momentPointM))
    return problem('CFD_PARAM_INVALID', 'reference areaM2 and lengthM must be > 0 and momentPointM finite', 'reference');
  const cells = c.cellsPerReferenceLength;
  if (cells !== undefined && !(cells >= MIN_CELLS_PER_LENGTH && cells <= MAX_CELLS_PER_LENGTH))
    return problem(
      'CFD_PARAM_INVALID',
      `cellsPerReferenceLength must be ${MIN_CELLS_PER_LENGTH}..${MAX_CELLS_PER_LENGTH}`,
      'cellsPerReferenceLength',
    );
  if (domain.rule === 'custom') {
    const { box } = domain;
    if (
      box === undefined ||
      !finiteVec(box.min) ||
      !finiteVec(box.max) ||
      !box.min.every((value, axis) => value < (box.max[axis] ?? value))
    )
      return problem('CFD_PARAM_INVALID', 'rule custom needs domain.box with finite min < max on every axis', 'domain.box');
  } else if (domain.box !== undefined) return problem('CFD_PARAM_INVALID', 'domain.box is only used with rule custom', 'domain.box');
  const badSlice = c.outputs.slices.some(
    (slice) => !finiteVec(slice.normal) || !finiteVec(slice.origin) || !slice.normal.some((n) => n !== 0),
  );
  if (badSlice || !c.outputs.probes.every(finiteVec))
    return problem('CFD_PARAM_INVALID', 'slice origins / normals (not zero) and probes must be finite', 'outputs');
  return null;
}

/**
 * First problem of the case, or null.
 * @failure order: unknown ids -> CFD_ENTITY_NOT_FOUND; numbers -> CFD_PARAM_INVALID; tags -> CFD_BOUNDARY_CONFLICT; free stream / solver -> CFD_PARAM_INVALID / CFD_REGIME_MISMATCH
 */
export function validateCase(doc: CadDocument, c: CfdCase, tolerated: readonly string[] = []): CaseProblem | null {
  const unknownId = entityProblem(doc, c, tolerated);
  return unknownId ?? semanticProblem(c);
}

/** The document-independent part of `validateCase` (numbers, tags, free stream); also used to validate a loaded slice. */
export function semanticProblem(c: CfdCase): CaseProblem | null {
  const flow = resolveFlow(c);
  const flowProblem = flow.ok ? null : problem(flow.code, flow.message, flow.code === 'CFD_REGIME_MISMATCH' ? 'regime' : 'freestream');
  const nonFlow = numberProblem(c) ?? boundaryProblem(c.boundaries);
  if (nonFlow !== null) return nonFlow;
  if (c.entityIds.length === 0) return problem('CFD_PARAM_INVALID', 'entityIds must list at least one body', 'entityIds');
  if (new Set(c.entityIds).size !== c.entityIds.length) return problem('CFD_PARAM_INVALID', 'entityIds lists an id twice', 'entityIds');
  return flowProblem;
}
