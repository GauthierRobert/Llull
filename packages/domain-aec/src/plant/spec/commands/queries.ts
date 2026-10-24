/** Read-only spec queries (plant 01 PSC M2): `list_pipe_specs`, `resolve_spec_component`, `resolve_branch`. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { refuse } from '../../catalog/codes';
import { BEND_RADII, COMPONENT_TYPES, END_TYPES, FACINGS } from '../../catalog/types';
import { resolveBranch, resolveComponent } from '../resolve';
import { sizeLabel } from '../size';
import { getSpecModel } from '../store';
import { SPEC_STATUSES, type PipeSpec } from '../types';
import { componentData, componentLine, isLoaded, loadSpec } from './answer';

const nominalParam = z.union([z.number(), z.string()]);

const specSummary = (revisions: readonly PipeSpec[]): Record<string, unknown> => {
  const latest = revisions.at(-1) as PipeSpec;
  return {
    id: latest.id,
    title: latest.title ?? null,
    latestRevision: latest.revision,
    status: latest.status,
    revisions: revisions.map((spec) => ({ revision: spec.revision, status: spec.status })),
    dimensionalStandard: latest.dimensionalStandard,
    rating: latest.rating,
    sizeRange: { from: latest.sizeRange.from, to: latest.sizeRange.to },
    catalogs: latest.catalogs,
    components: latest.components.length,
    types: [...new Set(latest.components.map((component) => component.type))].sort(),
    hasBranchTable: latest.branchTable !== undefined,
  };
};

/**
 * @affects none; data = { specs: [{ id, title, latestRevision, status, revisions, dimensionalStandard, rating, sizeRange, catalogs, components, types, hasBranchTable }], count }
 * @invariant read-only; specs in import order, revisions oldest first
 * @failure unknown specId -> PSC_SPEC_UNKNOWN
 */
export const listPipeSpecs = defineCommand({
  name: 'list_pipe_specs',
  description:
    'List the piping specs in the document: id, title, latest revision and status (draft, approved, superseded), every revision, dimensional standard (ASME or EN), rating basis, size range, ' +
    'catalogues searched, number of components, component types and whether a branch table exists. Filter by specId or by the status of the latest revision. ' +
    'Next: resolve_spec_component or resolve_branch to pick components, check_pipe_spec to validate, import_pipe_spec / create_pipe_spec to add one.',
  params: z.object({
    specId: z.string().describe('Only this spec id.').optional(),
    status: z.enum(SPEC_STATUSES).describe('Only specs whose latest revision has this status.').optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, { specId, status }): CommandResult => {
    const model = getSpecModel(doc);
    if (specId !== undefined && model.specs[specId] === undefined)
      return refuse(
        doc,
        'list_pipe_specs',
        'PSC_SPEC_UNKNOWN',
        `no spec "${specId}" (specs in this document: ${model.specOrder.join(', ') || 'none'})`,
        [specId],
        ['specId'],
      );
    const specs = model.specOrder
      .filter((id) => specId === undefined || id === specId)
      .flatMap((id) => model.specs[id] ?? [])
      .reduce<Map<string, PipeSpec[]>>((groups, spec) => groups.set(spec.id, [...(groups.get(spec.id) ?? []), spec]), new Map());
    const summaries = [...specs.values()]
      .filter((revisions) => status === undefined || revisions.at(-1)?.status === status)
      .map(specSummary);
    return report(
      doc,
      `list_pipe_specs: ${summaries.length} spec(s)${summaries.length === 0 ? '' : ` [${summaries.map((entry) => `${entry['id']} r${entry['latestRevision']} ${entry['status']}`).join(', ')}]`}.`,
      { specs: summaries, count: summaries.length },
    );
  },
});

/**
 * @affects none; data = { componentId, type, schedule?, wallMm?, outsideDiameterMm?, <dim>Mm, dims, commodityCode?, verified, unverifiedDims, warnings? }
 * @invariant read-only; exactly one component or a refusal; the same (spec revision, query) always returns the same component; a standard with no catalogue family still returns the selection, unverified
 * @failure unknown spec -> PSC_SPEC_UNKNOWN; size outside the spec range -> PSC_SIZE_OUT_OF_RANGE; no component of the type covers the size -> PSC_NO_COMPONENT; two equal-priority matches -> PSC_AMBIGUOUS_COMPONENT; catalogue family without the row -> PSC_CATALOG_ROW_MISSING
 */
export const resolveSpecComponent = defineCommand({
  name: 'resolve_spec_component',
  description:
    'Pick the one component a pipe spec allows for a component type and nominal size (NPS inch designation such as "2-1/2" or 2.5, or DN) and return its catalogue dimensions in millimetres ' +
    'with verified flags, the schedule and wall (a butt-weld fitting takes the spec pipe schedule), the ends, the commodity code and the source. ' +
    'Reducing tees, olets and reducers need branchNps / branchDn. Refuses sizes outside the spec range (PSC_SIZE_OUT_OF_RANGE), types the spec does not define at that size (PSC_NO_COMPONENT) and ' +
    'equal-priority matches (PSC_AMBIGUOUS_COMPONENT). When the spec names a standard the catalogue does not hold (B16.11, olets) the component is still selected but verified is false (PSC_DATA_UNVERIFIED). ' +
    'Next: resolve_branch for branch connections, check_pipe_spec to validate the spec; routing commands consume this.',
  params: z.object({
    specId: z.string().describe('Spec id (list_pipe_specs).'),
    revision: z.number().int().positive().describe('Spec revision. Default: the newest.').optional(),
    type: z
      .enum(COMPONENT_TYPES)
      .describe(
        'Component type: pipe, elbow90, elbow45, tee, reducingTee, reducerConcentric, flangeWeldNeck, gasketSpiralWound, valveGate, weldolet …',
      ),
    nps: nominalParam.describe('Nominal pipe size, inch designation ("6", "2-1/2") or number (2.5). Give nps or dn.').optional(),
    dn: nominalParam.describe('Nominal diameter DN (integer). Converted through the fixed DN <-> NPS map when needed.').optional(),
    branchNps: nominalParam.describe('Branch / small-end NPS (reducing tee, olet, reducer).').optional(),
    branchDn: nominalParam.describe('Branch / small-end DN.').optional(),
    ends: z.enum(END_TYPES).describe('Only components with this end type (BW, SW, FL …).').optional(),
    facing: z.enum(FACINGS).describe('Only components with this flange face.').optional(),
    radius: z.enum(BEND_RADII).describe('Only elbows of this bend radius (LR, SR).').optional(),
    class: z.number().int().positive().describe('Only components of this pressure class (150, 3000 …).').optional(),
    pn: z.number().positive().describe('Only components of this EN PN.').optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, { specId, revision, ...query }): CommandResult => {
    const loaded = loadSpec(doc, 'resolve_spec_component', specId, revision);
    if (!isLoaded(loaded)) return loaded;
    const outcome = resolveComponent(loaded.spec, loaded.catalogs, query);
    if (!outcome.ok) return refuse(doc, 'resolve_spec_component', outcome.code, outcome.message, outcome.ids, outcome.paths);
    return report(
      doc,
      `resolve_spec_component: spec ${loaded.spec.id} r${loaded.spec.revision} -> ${componentLine(outcome.resolved)}.`,
      componentData(loaded.spec, outcome.resolved),
    );
  },
});

/**
 * @affects none; data = { fitting, fittingName, header, branch, stubIn? | the resolved component data (componentId, schedule, wallMm, dims …) }
 * @invariant read-only; the cell of the branch table decides the fitting; header and branch sizes are table keys (no interpolation); a stub-in has no component
 * @failure unknown spec -> PSC_SPEC_UNKNOWN; size outside the range -> PSC_SIZE_OUT_OF_RANGE; empty cell or no table -> PSC_BRANCH_UNDEFINED; no component for the fitting -> PSC_NO_COMPONENT
 */
export const resolveBranchCommand = defineCommand({
  name: 'resolve_branch',
  description:
    'Resolve a branch connection from the spec branch table: the fitting kind for a header size x branch size (T equal tee, RT reducing tee, W weldolet, S sockolet, TH threadolet, SI stub-in, SIR reinforced stub-in) ' +
    'and the spec component that makes it (a tee at the header size, a reducing tee, an olet whose header and branch ranges cover the sizes); a stub-in returns no component (the reinforcement check is pipe stress, pack 07). ' +
    'Sizes are NPS (inch designation or number) or DN. An empty cell, such as a branch larger than its header, is refused with PSC_BRANCH_UNDEFINED and the branches defined for that header. ' +
    'Next: resolve_spec_component for the other parts, edit_pipe_spec setBranchCell to fill a cell.',
  params: z.object({
    specId: z.string().describe('Spec id (list_pipe_specs).'),
    revision: z.number().int().positive().describe('Spec revision. Default: the newest.').optional(),
    headerNps: nominalParam.describe('Header (run) NPS, inch designation or number. Give headerNps or headerDn.').optional(),
    headerDn: nominalParam.describe('Header (run) DN.').optional(),
    branchNps: nominalParam.describe('Branch NPS, inch designation or number. Give branchNps or branchDn.').optional(),
    branchDn: nominalParam.describe('Branch DN.').optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, { specId, revision, ...query }): CommandResult => {
    const loaded = loadSpec(doc, 'resolve_branch', specId, revision);
    if (!isLoaded(loaded)) return loaded;
    const outcome = resolveBranch(loaded.spec, loaded.catalogs, query);
    if (!outcome.ok) return refuse(doc, 'resolve_branch', outcome.code, outcome.message, outcome.ids, outcome.paths);
    const { fitting, fittingName, header, branch, component } = outcome.resolved;
    return report(
      doc,
      `resolve_branch: spec ${loaded.spec.id} r${loaded.spec.revision} header ${sizeLabel(header)} x branch ${sizeLabel(branch)} -> ${fitting} (${fittingName})${component === null ? ', no fitting component' : ` ${componentLine(component)}`}.`,
      {
        specId: loaded.spec.id,
        revision: loaded.spec.revision,
        fitting,
        fittingName,
        header,
        branch,
        ...(component === null ? { stubIn: true } : componentData(loaded.spec, component)),
      },
    );
  },
});
