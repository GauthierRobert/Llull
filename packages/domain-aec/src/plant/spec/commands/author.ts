/** Spec authoring commands (plant 01 PSC M2): `import_pipe_spec`, `create_pipe_spec`, `edit_pipe_spec` (all mutating, stored in `doc.plant.spec`). */

import { defineCommand, z } from '@core/commands/schema';
import { changed, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { elementsOf, getBuilding } from '../../../building/model';
import { refuse } from '../../catalog/codes';
import { applyEditOps, editOpSchema } from '../edit';
import { canonicalSpecText, headerShape, parseSpecFile, specToFile, SPEC_FORMAT, SPEC_ID_PATTERN, type SpecIssue } from '../file';
import { inRange, querySize } from '../size';
import { getSpecModel, latestSpec, withSpecModel } from '../store';
import type { PipeSpec } from '../types';

/** The spec as a draft: status draft, no approval block. */
const draftOf = (spec: PipeSpec): PipeSpec => ({
  ...(Object.fromEntries(Object.entries(spec).filter(([key]) => key !== 'approval')) as unknown as PipeSpec),
  status: 'draft',
});

/** A spec as a draft with no approval and revision 0: what two imports are compared on. */
const content = (spec: PipeSpec): string => canonicalSpecText({ ...draftOf(spec), revision: 0 });

function withRevisions(doc: CadDocument, spec: PipeSpec, replaceLast: boolean): CadDocument {
  const model = getSpecModel(doc);
  const revisions = model.specs[spec.id] ?? [];
  return withSpecModel(doc, {
    specs: { ...model.specs, [spec.id]: replaceLast ? [...revisions.slice(0, -1), spec] : [...revisions, spec] },
    specOrder: revisions.length === 0 ? [...model.specOrder, spec.id] : model.specOrder,
  });
}

const specStats = (spec: PipeSpec): string =>
  `${spec.components.length} component(s), ${Object.values(spec.branchTable?.cells ?? {}).reduce((count, row) => count + Object.keys(row).length, 0)} branch cell(s)`;

const issueRefusal = (doc: CadDocument, command: string, issues: readonly SpecIssue[]): CommandResult => ({
  ...refuse(
    doc,
    command,
    issues[0]?.code ?? 'PSC_SPEC_INVALID',
    `${issues.length} problem(s), first: ${issues[0]?.message ?? 'invalid spec'}`,
    [],
    issues.map((issue) => issue.path),
  ),
  data: { issues },
});

/**
 * @affects plant.spec.specs[spec.id] (document slice; a new revision when replace:true replaces content of a non-draft latest revision)
 * @invariant stored status is always draft (approval needs the human gate); identical content changes nothing; non-identical content under an existing id needs replace:true; corrosion allowance is stored in mm
 * @failure bad structure / unknown size / duplicate component id / from > to -> PSC_SPEC_INVALID (paths); corrosion unit not mm / in -> PSC_UNIT_INVALID; id clash with different content -> PSC_SPEC_CONFLICT
 */
export const importPipeSpec = defineCommand({
  name: 'import_pipe_spec',
  description:
    'Import a piping spec file into the document as a draft. The file is { format: "llull-pipe-spec", schemaVersion: 1, id, revision?, title?, service?, dimensionalStandard (ASME | EN | ISO | company: required, no default), ' +
    'rating { system, class | pn, materialGroup }, materials?, corrosionAllowance { value, unit: mm | in } (required), millTolerance?, designLimits { minTemperatureC, maxTemperatureC }?, ' +
    'sizeRange { fromNps, toNps } or { fromDn, toDn }, catalogs: [catalogue ids searched in order], components: [{ id, type, fromNps/toNps or fromDn/toDn, catalogRef, ends?, facing?, class?, radius?, schedule? | scheduleFromPipe?, wallMm?, priority?, ' +
    'branchFromNps/branchToNps? (olets, reducing tees), commodityCode? }], branchTable { cells: { "<header NPS>": { "<branch NPS>": T | RT | W | S | TH | SI | SIR } } }, status? }. ' +
    'The spec is always stored as draft: approval is a separate human-gated act. Importing identical content changes nothing; different content under an existing id needs replace:true (a draft is overwritten, an approved spec gets a new revision). ' +
    'Next: check_pipe_spec to validate it, resolve_spec_component / resolve_branch to use it, export_pipe_spec for the canonical file.',
  params: z.object({
    spec: z.record(z.string(), z.unknown()).describe('The spec file object (format llull-pipe-spec, schemaVersion 1).'),
    replace: z
      .boolean()
      .describe('Overwrite a spec with the same id but different content. Default false: such a clash is refused (PSC_SPEC_CONFLICT).')
      .optional(),
  }),
  run: (doc, { spec, replace = false }): CommandResult => {
    const parsed = parseSpecFile(spec);
    if ('issues' in parsed) return issueRefusal(doc, 'import_pipe_spec', parsed.issues);
    const incoming = parsed.spec;
    const latest = latestSpec(doc, incoming.id);
    const forced = incoming.status !== 'draft';
    if (latest === undefined) {
      const stored = draftOf(incoming);
      return {
        ...changed(
          withRevisions(doc, stored, false),
          `Imported pipe spec ${stored.id} r${stored.revision} as draft: ${specStats(stored)}${forced ? ` (status ${incoming.status} in the file ignored: approval needs the human gate)` : ''}.`,
          [],
        ),
        data: {
          specId: stored.id,
          revision: stored.revision,
          status: 'draft',
          components: stored.components.length,
          statusForcedToDraft: forced,
          replaced: false,
        },
      };
    }
    if (content(latest) === content(incoming))
      return report(
        doc,
        `import_pipe_spec: spec ${incoming.id} r${latest.revision} already present with identical content; nothing changed.`,
        { specId: incoming.id, revision: latest.revision, unchanged: true },
      );
    if (!replace)
      return refuse(
        doc,
        'import_pipe_spec',
        'PSC_SPEC_CONFLICT',
        `spec ${incoming.id} already exists (r${latest.revision}) with different content`,
        [incoming.id],
        ['spec.id'],
      );
    const inPlace = latest.status === 'draft';
    const stored = { ...draftOf(incoming), revision: inPlace ? latest.revision : latest.revision + 1 };
    return {
      ...changed(
        withRevisions(doc, stored, inPlace),
        `Imported pipe spec ${stored.id} as ${inPlace ? 'a replaced draft' : 'new draft revision'} r${stored.revision}: ${specStats(stored)}.`,
        [],
      ),
      data: {
        specId: stored.id,
        revision: stored.revision,
        status: 'draft',
        components: stored.components.length,
        statusForcedToDraft: forced,
        replaced: true,
      },
    };
  },
});

/**
 * @affects plant.spec.specs[id] (a new empty draft revision 1)
 * @invariant the safety-relevant header (dimensional standard, rating, corrosion allowance, size range, catalogues) is required: nothing is defaulted
 * @failure id exists -> PSC_SPEC_CONFLICT; bad header / size -> PSC_SPEC_INVALID (paths); unit -> PSC_UNIT_INVALID
 */
export const createPipeSpec = defineCommand({
  name: 'create_pipe_spec',
  description:
    'Create an empty draft piping spec: only the header (id, dimensional standard ASME or EN, rating basis, corrosion allowance, size range, catalogues searched, optional service, materials, mill tolerance, design temperature limits). ' +
    'Nothing is defaulted: the dimensional standard, rating, corrosion allowance and size range must be named (safety data). Then add components and branch cells with edit_pipe_spec. ' +
    'Refuses an existing id (PSC_SPEC_CONFLICT). Next: edit_pipe_spec, then check_pipe_spec.',
  params: z.object({
    id: z.string().regex(SPEC_ID_PATTERN).describe('Spec id, 1 to 64 characters of A-Z a-z 0-9 . _ -, e.g. "CS150-A1".'),
    ...headerShape,
  }),
  run: (doc, params): CommandResult => {
    const parsed = parseSpecFile({ format: SPEC_FORMAT, schemaVersion: 1, ...params, components: [], status: 'draft' });
    if ('issues' in parsed) return issueRefusal(doc, 'create_pipe_spec', parsed.issues);
    if (latestSpec(doc, parsed.spec.id) !== undefined)
      return refuse(doc, 'create_pipe_spec', 'PSC_SPEC_CONFLICT', `spec ${parsed.spec.id} already exists`, [parsed.spec.id], ['id']);
    return {
      ...changed(
        withRevisions(doc, parsed.spec, false),
        `Created draft pipe spec ${parsed.spec.id} r1 (${parsed.spec.dimensionalStandard}, no components yet).`,
        [],
      ),
      data: { specId: parsed.spec.id, revision: 1, status: 'draft', components: 0 },
    };
  },
});

/** Pipes bound to `specId` whose size no `pipe` component of the edited spec covers any more. */
function orphanedPipes(doc: CadDocument, edited: PipeSpec): string[] {
  return elementsOf(getBuilding(doc), 'pipe')
    .filter((pipe) => {
      const binding = pipe.spec;
      const size = binding === undefined ? null : (querySize({ nps: binding.nps }) ?? querySize({ dn: binding.nps }));
      return (
        binding?.specId === edited.id &&
        size !== null &&
        !edited.components.some((component) => component.type === 'pipe' && inRange(size, component.from, component.to))
      );
    })
    .map((pipe) => pipe.id);
}

/**
 * @affects plant.spec.specs[specId] (same revision while the latest is a draft; a new draft revision when it is approved or superseded)
 * @invariant ops apply in order, all or nothing; the edited spec must pass the import schema; a spec identical to the current one creates no revision
 * @failure unknown spec -> PSC_SPEC_UNKNOWN; malformed op or invalid result -> PSC_SPEC_INVALID (paths ops.N / spec paths); removing the pipe a bound pipe element needs -> PSC_SPEC_IN_USE
 */
export const editPipeSpec = defineCommand({
  name: 'edit_pipe_spec',
  description:
    'Edit a piping spec with ordered operations, all or nothing: addComponent, updateComponent (members to change; null removes one), removeComponent, setSizeRange, setBranchCell (header, branch, fitting T | RT | W | S | TH | SI | SIR), ' +
    'clearBranchCell, setHeader (title, service, dimensionalStandard, rating, materials, corrosionAllowance, millTolerance, designLimits, catalogs, elbowAngles, provenance). ' +
    'Component sizes are fromNps / toNps (inch designation) or fromDn / toDn. A draft spec is edited in place; editing an approved spec creates a new draft revision. ' +
    'The result is validated like an import (PSC_SPEC_INVALID with the path, e.g. ops.2.id); removing the pipe component that a bound pipe element needs is refused (PSC_SPEC_IN_USE). ' +
    'Next: check_pipe_spec, resolve_spec_component.',
  params: z.object({
    specId: z.string().describe('Spec id (list_pipe_specs).'),
    ops: z
      .array(editOpSchema)
      .min(1)
      .max(200)
      .describe(
        'Operations applied in order; each is { op, ... } (addComponent, updateComponent, removeComponent, setSizeRange, setBranchCell, clearBranchCell, setHeader).',
      ),
  }),
  run: (doc, { specId, ops }): CommandResult => {
    const current = latestSpec(doc, specId);
    if (current === undefined)
      return refuse(
        doc,
        'edit_pipe_spec',
        'PSC_SPEC_UNKNOWN',
        `no spec "${specId}" (specs in this document: ${getSpecModel(doc).specOrder.join(', ') || 'none'})`,
        [specId],
        ['specId'],
      );
    const applied = applyEditOps(specToFile(current), ops);
    if ('issue' in applied) return refuse(doc, 'edit_pipe_spec', 'PSC_SPEC_INVALID', applied.issue.message, [specId], [applied.issue.path]);
    const parsed = parseSpecFile(applied.file);
    if ('issues' in parsed) return issueRefusal(doc, 'edit_pipe_spec', parsed.issues);
    const inPlace = current.status === 'draft';
    const edited: PipeSpec = { ...draftOf(parsed.spec), revision: inPlace ? current.revision : current.revision + 1 };
    if (content(edited) === content(current))
      return report(doc, `edit_pipe_spec: spec ${specId} r${current.revision} is unchanged by these operations.`, {
        specId,
        revision: current.revision,
        unchanged: true,
      });
    const orphans = orphanedPipes(doc, edited);
    if (orphans.length > 0)
      return refuse(
        doc,
        'edit_pipe_spec',
        'PSC_SPEC_IN_USE',
        `${orphans.length} pipe element(s) bound to ${specId} would have no pipe component: ${orphans.join(', ')}`,
        orphans,
        ['ops'],
      );
    return {
      ...changed(
        withRevisions(doc, edited, inPlace),
        `Edited pipe spec ${specId}: ${ops.length} operation(s), ${inPlace ? 'draft' : 'new draft revision'} r${edited.revision}, ${specStats(edited)}.`,
        [],
      ),
      data: {
        specId,
        revision: edited.revision,
        status: 'draft',
        newRevision: !inPlace,
        operations: ops.length,
        components: edited.components.length,
      },
    };
  },
});
