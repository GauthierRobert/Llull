/** Case commands of the cfd plugin (12 CFD §4): create_cfd_case, update_cfd_case, delete_cfd_case, set_cfd_boundary. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { entityBoundsInDoc, mergeBounds } from '@core/geometry/bounds';
import { toMetres } from '@core/model/units';
import { is3D, type CadDocument, type Vec3 } from '@core/model/types';
import type { CfdBoundaryTag, CfdCase } from '@aero/cfd/types';
import { briefNumbers } from '../shared/results';
import { caseHashOf, caseOf, cfdSlice, withCfd } from './caseDoc';
import {
  applyFields,
  boundariesShape,
  caseFieldShape,
  createRequiredShape,
  toFreestream,
  type CaseFields,
  type DefaultNote,
} from './caseParams';
import { tagsConflict, validateCase } from './caseValidate';
import { refuseCfd } from './codes';
import { resolveFlow } from './regime';

const CASE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const DEFAULT_SOURCE = 'llull default';

/** Centre of the bounding box of the 3D bodies, in metres (world axes); the origin when none is found. */
function bodiesCentre(doc: CadDocument, ids: readonly string[]): Vec3 {
  const boxes = ids.flatMap((id) => {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    return entity !== undefined && is3D(entity) ? [entityBoundsInDoc(doc, entity)] : [];
  });
  const [first, ...rest] = boxes;
  if (first === undefined) return [0, 0, 0];
  const { min, max } = rest.reduce(mergeBounds, first);
  return [0, 1, 2].map((axis) => toMetres(doc, ((min[axis] ?? 0) + (max[axis] ?? 0)) / 2)) as unknown as Vec3;
}

const defaultNotes = (fields: CaseFields, momentGiven: boolean): DefaultNote[] => {
  const note = (path: string, value: unknown, missing: boolean): DefaultNote[] =>
    missing ? [{ path, value, source: DEFAULT_SOURCE }] : [];
  return [
    ...note('regime', 'auto', fields.regime === undefined),
    ...note('freestream.alphaDeg', 0, fields.freestream?.alphaDeg === undefined),
    ...note('freestream.betaDeg', 0, fields.freestream?.betaDeg === undefined),
    ...note('flowAxis', [1, 0, 0], fields.flowAxis === undefined),
    ...note('upAxis', [0, 0, 1], fields.upAxis === undefined),
    ...note('reference.momentPointM', 'centre of the bodies bounding box', !momentGiven),
    ...note('domain.rule', 'external_aero', fields.domain?.rule === undefined),
    ...note('ground', { enabled: false, moving: false }, fields.ground === undefined),
    ...note('quality', 'standard', fields.quality === undefined && fields.cellsPerReferenceLength === undefined),
  ];
};

/**
 * @affects doc.cfd.cases (adds 1 case; affected: [caseId])
 * @invariant lengths are metres; the bodies stay ordinary entities; defaults are listed in data.defaults
 * @failure bad id / numbers -> CFD_PARAM_INVALID; unknown entity -> CFD_ENTITY_NOT_FOUND; duplicate id -> CFD_CASE_EXISTS; Mach/regime/solver mismatch -> CFD_REGIME_MISMATCH
 */
export const cfdCreateCase = defineCommand({
  name: 'create_cfd_case',
  description:
    'Create a flow-simulation (CFD) case: the bodies to put in the flow, the free stream (Mach or speed, altitude or air state, angle of attack / ' +
    'sideslip), the reference area / length of the force coefficients, the domain rule and the grid quality. Nothing is solved or meshed: run ' +
    'prepare_cfd_case next for the pass / warn / fail list (watertight, small features, domain, blockage, memory). The regime picks the solver: Mach < 0.3 ' +
    'is low-speed (lattice Boltzmann), 0.3..5 is compressible (Euler); a regime or forced solver outside its range is refused with ' +
    'CFD_REGIME_MISMATCH. Lengths are metres. Returns the case and the defaults it applied.',
  params: z.object({
    id: z.string().describe('New case id (letters, digits, "_", "-", "."; max 64). Returned in affected[0].'),
    ...caseFieldShape,
    ...createRequiredShape,
  }),
  run: (doc, params): CommandResult => {
    const { id, ...fields } = params;
    if (!CASE_ID.test(id))
      return refuseCfd(doc, 'create_cfd_case', 'CFD_PARAM_INVALID', `case id '${id}' must match [A-Za-z0-9_.-]{1,64}`, [], ['id']);
    if (caseOf(doc, id) !== undefined)
      return refuseCfd(doc, 'create_cfd_case', 'CFD_CASE_EXISTS', `case '${id}' already exists`, [id], ['id']);
    const base: CfdCase = {
      id,
      entityIds: [],
      excludedEntityIds: [],
      regime: 'auto',
      freestream: toFreestream(fields.freestream),
      flowAxis: [1, 0, 0],
      upAxis: [0, 0, 1],
      reference: {
        areaM2: fields.reference.areaM2 ?? 0,
        lengthM: fields.reference.lengthM ?? 0,
        momentPointM: bodiesCentre(doc, fields.entityIds),
      },
      domain: { rule: 'external_aero' },
      ground: { enabled: false, moving: false },
      boundaries: [],
      quality: 'standard',
      outputs: { surfaceFields: [], slices: [], probes: [] },
    };
    const next = applyFields(base, fields);
    const invalid = validateCase(doc, next);
    if (invalid !== null) return refuseCfd(doc, 'create_cfd_case', invalid.code, invalid.message, invalid.ids, [invalid.path]);
    const flow = resolveFlow(next);
    const defaults = defaultNotes(fields, fields.reference.momentPointM !== undefined);
    const solver = flow.ok ? flow.state.solver : 'none';
    const mach = flow.ok ? flow.state.machNumber : 0;
    const summary = briefNumbers(
      `create_cfd_case: case '${id}' created — ${next.entityIds.length} body(ies), Mach ${mach}, solver ${solver}, ` +
        `${next.cellsPerReferenceLength ?? { draft: 64, standard: 128, fine: 256 }[next.quality]} cells per reference length ` +
        `(${defaults.length} default(s) applied). Next: prepare_cfd_case caseId=${id}.`,
    );
    const cases = { ...cfdSlice(doc).cases, [id]: next };
    return {
      ...changed(withCfd(doc, { cases }), summary, [id]),
      data: { case: next, defaults, caseHash: caseHashOf(next), machNumber: mach, solver },
    };
  },
});

/**
 * @affects doc.cfd.cases[caseId] (replaces the given fields; affected: [caseId]); recorded results of the case become stale (hash differs)
 * @invariant free stream replaces as a whole; reference / domain / ground / outputs merge one level; boundaries replace as a list
 * @failure unknown case -> CFD_CASE_NOT_FOUND; no field given / bad numbers -> CFD_PARAM_INVALID; unknown entity -> CFD_ENTITY_NOT_FOUND; tag clash -> CFD_BOUNDARY_CONFLICT; Mach mismatch -> CFD_REGIME_MISMATCH
 */
export const cfdUpdateCase = defineCommand({
  name: 'update_cfd_case',
  description:
    'Change fields of an existing flow case (any field of create_cfd_case, plus `boundaries` to replace the whole tag list). The free stream is ' +
    'replaced as a whole; reference, domain, ground and outputs change only the members you give. The next case is validated like a new one ' +
    '(same codes). A recorded result of the case becomes stale (its case hash no longer matches) and is not deleted.',
  params: z.object({ caseId: z.string().describe('Id of the case to change.'), ...caseFieldShape, boundaries: boundariesShape }),
  run: (doc, params): CommandResult => {
    const { caseId, ...fields } = params;
    const previous = caseOf(doc, caseId);
    if (previous === undefined) return refuseCfd(doc, 'update_cfd_case', 'CFD_CASE_NOT_FOUND', `no case '${caseId}'`, [caseId], ['caseId']);
    const given = Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    if (given.length === 0)
      return refuseCfd(doc, 'update_cfd_case', 'CFD_PARAM_INVALID', 'no field to change was given', [caseId], ['caseId']);
    const next = applyFields(previous, fields);
    const alreadyGone = [...previous.entityIds, ...previous.excludedEntityIds, ...previous.boundaries.map((tag) => tag.entityId)].filter(
      (id) => !Object.hasOwn(doc.entities, id),
    );
    const invalid = validateCase(doc, next, alreadyGone);
    if (invalid !== null) return refuseCfd(doc, 'update_cfd_case', invalid.code, invalid.message, invalid.ids, [invalid.path]);
    const slice = cfdSlice(doc);
    const result = Object.hasOwn(slice.results, caseId) ? slice.results[caseId] : undefined;
    const caseHash = caseHashOf(next);
    const stale = result !== undefined && result.caseHash !== caseHash;
    const notes =
      fields.entityIds !== undefined && fields.reference?.momentPointM === undefined
        ? ['reference.momentPointM was not recomputed for the new bodies: pass reference.momentPointM to move it']
        : [];
    const summary =
      `update_cfd_case: case '${caseId}' updated (${given.join(', ')})${stale ? '; its recorded result is now stale' : ''}.` +
      (notes.length > 0 ? ` Note: ${notes.join('; ')}.` : '');
    return {
      ...changed(withCfd(doc, { cases: { ...slice.cases, [caseId]: next } }), summary, [caseId]),
      data: { case: next, caseHash, resultStale: stale, changed: given, notes },
    };
  },
});

/**
 * @affects doc.cfd.cases, doc.cfd.results (removes the case and its recorded result; affected: [caseId]); bodies are untouched
 * @failure unknown case -> CFD_CASE_NOT_FOUND
 */
export const cfdDeleteCase = defineCommand({
  name: 'delete_cfd_case',
  description: 'Delete a flow case and its recorded result summary from the document. The bodies (entities) are not touched.',
  params: z.object({ caseId: z.string().describe('Id of the case to delete.') }),
  run: (doc, { caseId }): CommandResult => {
    if (caseOf(doc, caseId) === undefined)
      return refuseCfd(doc, 'delete_cfd_case', 'CFD_CASE_NOT_FOUND', `no case '${caseId}'`, [caseId], ['caseId']);
    const slice = cfdSlice(doc);
    const without = <T>(record: Readonly<Record<string, T>>): Record<string, T> =>
      Object.fromEntries(Object.entries(record).filter(([key]) => key !== caseId));
    return changed(
      withCfd(doc, { cases: without(slice.cases), results: without(slice.results) }),
      `delete_cfd_case: removed case '${caseId}'.`,
      [caseId],
    );
  },
});

function withTag(tags: readonly CfdBoundaryTag[], tag: CfdBoundaryTag): CfdBoundaryTag[] {
  const same = tags.findIndex(
    (old) => old.entityId === tag.entityId && old.kind === tag.kind && (old.faceRefs === undefined) === (tag.faceRefs === undefined),
  );
  if (same < 0) return [...tags, tag];
  const old = tags[same];
  const faceRefs = old?.faceRefs === undefined || tag.faceRefs === undefined ? undefined : [...new Set([...old.faceRefs, ...tag.faceRefs])];
  const merged: CfdBoundaryTag = { kind: tag.kind, entityId: tag.entityId, ...(faceRefs !== undefined && { faceRefs }) };
  return tags.map((entry, index) => (index === same ? merged : entry));
}

/**
 * @affects doc.cfd.cases[caseId].boundaries (adds or merges 1 tag; affected: [caseId])
 * @invariant an entity (or face) carries one kind; the same kind again merges face refs
 * @failure unknown case -> CFD_CASE_NOT_FOUND; entity not a body of the case -> CFD_ENTITY_NOT_FOUND; different kind on the same entity / face -> CFD_BOUNDARY_CONFLICT
 */
export const cfdSetBoundary = defineCommand({
  name: 'set_cfd_boundary',
  description:
    'Tag a body of a flow case as a boundary: wall, inlet, outlet, symmetry or ground. The tag is document data (replayed). Without faceRefs the whole ' +
    'entity carries the condition (model an intake or a nozzle end as its own entity); with faceRefs only those stable face refs do. An entity or ' +
    'face carries one kind: tagging it with a different kind is refused (CFD_BOUNDARY_CONFLICT); clear tags with update_cfd_case boundaries=[]. ' +
    'Untagged surfaces are walls.',
  params: z.object({
    caseId: z.string().describe('Id of the case.'),
    kind: z.enum(['wall', 'inlet', 'outlet', 'symmetry', 'ground']).describe('Boundary condition kind.'),
    entityId: z.string().describe('A body of the case (one of its entityIds).'),
    faceRefs: z.array(z.string()).optional().describe('Stable face refs of the entity; absent = the whole entity. Non-empty strings.'),
  }),
  run: (doc, { caseId, kind, entityId, faceRefs }): CommandResult => {
    const previous = caseOf(doc, caseId);
    if (previous === undefined)
      return refuseCfd(doc, 'set_cfd_boundary', 'CFD_CASE_NOT_FOUND', `no case '${caseId}'`, [caseId], ['caseId']);
    if (!previous.entityIds.includes(entityId) || !Object.hasOwn(doc.entities, entityId))
      return refuseCfd(
        doc,
        'set_cfd_boundary',
        'CFD_ENTITY_NOT_FOUND',
        `entity '${entityId}' is not a body of case '${caseId}'`,
        [entityId],
        ['entityId'],
      );
    if (faceRefs !== undefined && (faceRefs.length === 0 || faceRefs.some((ref) => ref === '')))
      return refuseCfd(
        doc,
        'set_cfd_boundary',
        'CFD_PARAM_INVALID',
        'faceRefs must be a non-empty list of non-empty strings',
        [entityId],
        ['faceRefs'],
      );
    const tag: CfdBoundaryTag = { kind, entityId, ...(faceRefs !== undefined && { faceRefs: [...faceRefs] }) };
    const clash = previous.boundaries.find((old) => tagsConflict(old, tag));
    if (clash !== undefined)
      return refuseCfd(
        doc,
        'set_cfd_boundary',
        'CFD_BOUNDARY_CONFLICT',
        `entity '${entityId}' is already tagged ${clash.kind}`,
        [entityId],
        ['kind'],
      );
    const boundaries = withTag(previous.boundaries, tag);
    const next: CfdCase = { ...previous, boundaries };
    const slice = cfdSlice(doc);
    const summary = `set_cfd_boundary: ${entityId} -> ${kind}${faceRefs !== undefined ? ` (${faceRefs.length} face(s))` : ''} in case '${caseId}'; ${boundaries.length} tag(s).`;
    return { ...changed(withCfd(doc, { cases: { ...slice.cases, [caseId]: next } }), summary, [caseId]), data: { boundaries } };
  },
});
