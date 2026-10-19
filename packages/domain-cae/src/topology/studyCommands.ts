/** create_topology_study / set_topology_regions / set_topology_settings / delete_topology_study: the set-up of a topology study (PHY-17). */

import type { NamedFlag, NamedValue, TopologySettings, TopologyStudy } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { analysisIdSchema } from '../shared/schemas';
import { caseOf } from '../shared/access';
import { refuseTopology } from './codes';
import { defaultSettings } from './defaults';
import { findStudy, withStudy, withoutStudy } from './model';
import { regionSchema, studyIdSchema, toRegion } from './schemas';
import { regionMasks } from './regions';
import { domainTriangles, gridOver, insideMask, isGridRefusal } from './voxel';

const planeSchema = z.enum(['XY', 'XZ', 'YZ']);

/**
 * @affects doc.analysis.cases[analysisId].topology (adds 1 study; affected: [studyId])
 * @invariant ids `ts-<step>.<k>`; settings are filled with the named defaults (the summary names them); the grid is the AABB of the design
 *   domain at `voxel` spacing; no keep-in region yet (load and support layers are protected at solve time, see protectLoadSupport)
 * @failure unknown analysis -> TOP_ANALYSIS_MISSING; domain empty / not solids / not parts of the analysis -> TOP_DOMAIN_INVALID; volumeFraction
 *   outside (0, 1) -> TOP_VOLUME_FRACTION_INVALID; grid above the cap -> TOP_GRID_TOO_LARGE; voxel <= 0, plane on a 3D study, non-positive
 *   load case weight -> TOP_SETUP_INVALID (all refusals, unchanged doc)
 */
export const createTopologyStudy = defineCommand({
  name: 'create_topology_study',
  description:
    'Create a minimum-compliance topology optimization study on an existing analysis (create_analysis + set_part_idealization + ' +
    'add_fea_constraint + add_fea_load, the loads must be force loads) and return the study id in affected[0]. `voxel` is the grid spacing in ' +
    'document length units (e.g. 1 for 1 mm voxels); `volumeFraction` is the share of the design domain that may stay solid (0.7 = 30 % lighter). ' +
    '`designDomain` lists solids that are parts of the analysis and share one material (E and nu come from it). A 2D study (dimension 2) ' +
    'optimises a plane-stress layout on the grid of one plane (default XY) across the thickness of the domain; a 3D study uses voxels. Every ' +
    'setting starts at a named default (see the summary; change them with set_topology_settings). Refuses non-solids and grids above the voxel cap. ' +
    'Next: set_topology_regions to protect bosses and interfaces, then run the topology_solve transport (it stores the result with ' +
    'record_topology_result), then topology_report, suggest_rebuild, compare_to_topology and check_topology.',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z.string().min(1).describe('Display name of the study, e.g. "bracket 30 % lighter".'),
    designDomain: z
      .array(z.string())
      .describe('Ids of the 3D solids that may be reshaped. They must be parts of the analysis and share one material.'),
    dimension: z
      .union([z.literal(2), z.literal(3)])
      .describe('2 = plane-stress layout on one plane (needs a plate-like domain); 3 = voxel solid.'),
    plane: planeSchema
      .optional()
      .describe('2D only: the grid plane, XY (default), XZ or YZ. The out-of-plane extent of the domain is the thickness.'),
    voxel: z.number().describe('Grid spacing in document length units, > 0. Smaller voxels resolve thinner members and cost more time.'),
    volumeFraction: z.number().describe('Share of the design domain voxels that may stay solid, in (0, 1). 0.7 = 30 % lighter.'),
    objective: z
      .object({
        kind: z.literal('min_compliance').describe('Minimise compliance (maximise stiffness). The only objective built.'),
        loadCaseWeights: z
          .record(z.string(), z.number())
          .optional()
          .describe('Weight of each load case name in the weighted compliance; a case not listed weighs 1.'),
      })
      .optional()
      .describe('Objective; default min_compliance with every load case weighing 1.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [], paths: readonly string[] = []): CommandResult =>
      refuseTopology(doc, 'create_topology_study', code, message, ids, paths);
    const analysisCase = caseOf(doc, params.analysisId);
    if (analysisCase === undefined)
      return fail('TOP_ANALYSIS_MISSING', `no analysis '${params.analysisId}'`, [params.analysisId], ['analysisId']);
    if (!(params.volumeFraction > 0 && params.volumeFraction < 1))
      return fail('TOP_VOLUME_FRACTION_INVALID', `volumeFraction ${params.volumeFraction} is not in (0, 1)`, [], ['volumeFraction']);
    if (!(params.voxel > 0) || !Number.isFinite(params.voxel))
      return fail('TOP_SETUP_INVALID', `voxel ${params.voxel} must be > 0`, [], ['voxel']);
    if (params.plane !== undefined && params.dimension === 3)
      return fail('TOP_SETUP_INVALID', 'plane applies to 2D studies only', [], ['plane']);
    const weights = params.objective?.loadCaseWeights ?? {};
    const badWeight = Object.entries(weights).find(([, weight]) => !(weight > 0) || !Number.isFinite(weight));
    if (badWeight !== undefined)
      return fail(
        'TOP_SETUP_INVALID',
        `load case weight '${badWeight[0]}' = ${badWeight[1]} must be > 0`,
        [],
        ['objective.loadCaseWeights'],
      );
    const notParts = params.designDomain.filter((id) => !Object.hasOwn(analysisCase.parts, id));
    if (params.designDomain.length === 0 || notParts.length > 0)
      return fail(
        'TOP_DOMAIN_INVALID',
        params.designDomain.length === 0
          ? 'the design domain is empty'
          : `${notParts.join(', ')} ${notParts.length === 1 ? 'is' : 'are'} not part(s) of analysis '${params.analysisId}' (set_part_idealization)`,
        notParts,
        ['designDomain'],
      );
    const triangles = domainTriangles(doc, params.designDomain);
    if (!Array.isArray(triangles)) return fail(triangles.code, triangles.message, triangles.ids, ['designDomain']);
    const study: TopologyStudy = {
      id: nextId('ts'),
      name: params.name,
      analysisId: params.analysisId,
      dimension: params.dimension,
      ...(params.dimension === 2 ? { plane: params.plane ?? 'XY' } : {}),
      designDomain: params.designDomain,
      keepIn: [],
      keepOut: [],
      voxel: params.voxel,
      volumeFraction: params.volumeFraction,
      objective: { kind: 'min_compliance', loadCaseWeights: weights },
      manufacturing: { symmetry: [] },
      settings: defaultSettings(params.voxel),
    };
    const grid = gridOver(study, triangles);
    if (isGridRefusal(grid)) return fail(grid.code, grid.message, [], ['voxel']);
    const size = grid.dimension === 2 ? `${grid.nx} x ${grid.ny}` : `${grid.nx} x ${grid.ny} x ${grid.nz}`;
    return changed(
      withStudy(doc, study),
      `create_topology_study: ${study.id} '${study.name}' — ${study.dimension}D${study.plane === undefined ? '' : ` ${study.plane}`} grid ${size} = ${grid.count} voxels of ${study.voxel} ${doc.units}, volume fraction ${study.volumeFraction}; settings at named defaults (penal 3, move 0.2, filter ${study.settings.filter.kind} radius ${study.settings.filter.radius.value} ${doc.units}, changeTol 0.01, max 300 iterations; protectLoadSupport true); next: set_topology_regions, then topology_solve.`,
      [study.id],
    );
  },
});

/**
 * @affects doc.analysis.cases[a].topology[studyId].keepIn / keepOut (each list given REPLACES the old one)
 * @invariant every region intersects the design domain; keep-in and keep-out voxels are disjoint; keep-in voxels stay below the volume budget
 * @failure unknown study -> TOP_STUDY_NOT_FOUND; neither list given, or regions that overlap each other -> TOP_SETUP_INVALID; a region outside the
 *   domain or an unmappable target -> TOP_REGION_OUTSIDE_DOMAIN; keep-in voxels >= volumeFraction x active voxels -> TOP_KEEPIN_EXCEEDS_BUDGET
 */
export const setTopologyRegions = defineCommand({
  name: 'set_topology_regions',
  description:
    'Set the regions of a topology study that must stay solid (keepIn: interfaces, bolt bosses, loaded faces) or must stay empty (keepOut: ' +
    'clearances, routing). Each list you give REPLACES the existing one; omit a list to keep it. A region is a box (world coordinates), another solid ' +
    '(entity) or the voxel layers next to a face / edge / point of a part (target, depthVoxels). Refused when a region does not touch the design ' +
    'domain (TOP_REGION_OUTSIDE_DOMAIN), when keep-in and keep-out overlap, or when the keep-in volume alone reaches the volume budget ' +
    '(TOP_KEEPIN_EXCEEDS_BUDGET: raise volumeFraction or shrink the keep-in regions). Load and support layers are protected automatically ' +
    '(settings.protectLoadSupport), you do not add them here. A recorded result becomes stale.',
  params: z.object({
    studyId: studyIdSchema,
    keepIn: z.array(regionSchema).optional().describe('Regions that stay solid (replaces the existing keepIn list; [] clears it).'),
    keepOut: z.array(regionSchema).optional().describe('Regions that stay empty (replaces the existing keepOut list; [] clears it).'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [], paths: readonly string[] = []): CommandResult =>
      refuseTopology(doc, 'set_topology_regions', code, message, ids, paths);
    const found = findStudy(doc, params.studyId);
    if (found === undefined) return fail('TOP_STUDY_NOT_FOUND', `no topology study '${params.studyId}'`, [params.studyId], ['studyId']);
    if (params.keepIn === undefined && params.keepOut === undefined)
      return fail('TOP_SETUP_INVALID', 'give keepIn and / or keepOut', [params.studyId]);
    const study: TopologyStudy = {
      ...found.study,
      keepIn: params.keepIn === undefined ? found.study.keepIn : params.keepIn.map(toRegion),
      keepOut: params.keepOut === undefined ? found.study.keepOut : params.keepOut.map(toRegion),
    };
    const triangles = domainTriangles(doc, study.designDomain);
    if (!Array.isArray(triangles)) return fail(triangles.code, triangles.message, triangles.ids);
    const grid = gridOver(study, triangles);
    if (isGridRefusal(grid)) return fail(grid.code, grid.message, [study.id]);
    const active = insideMask(triangles, grid);
    const activeCount = active.reduce((sum, flag) => sum + flag, 0);
    const resolve = (list: 'keepIn' | 'keepOut'): CommandResult | { readonly mask: Uint8Array; readonly count: number } => {
      const outcome = regionMasks(doc, grid, active, study[list]);
      if ('error' in outcome)
        return fail('TOP_REGION_OUTSIDE_DOMAIN', `${list}[${outcome.index}]: ${outcome.error}`, [study.id], [`${list}.${outcome.index}`]);
      const empty = outcome.counts.indexOf(0);
      if (empty >= 0)
        return fail(
          'TOP_REGION_OUTSIDE_DOMAIN',
          `${list}[${empty}] contains no voxel of the design domain`,
          [study.id],
          [`${list}.${empty}`],
        );
      return { mask: outcome.mask, count: outcome.mask.reduce((sum, flag) => sum + flag, 0) };
    };
    const inside = resolve('keepIn');
    if ('document' in inside) return inside;
    const outside = resolve('keepOut');
    if ('document' in outside) return outside;
    const overlap = inside.mask.reduce((sum, flag, voxel) => sum + (flag & (outside.mask[voxel] ?? 0)), 0);
    if (overlap > 0) return fail('TOP_SETUP_INVALID', `${overlap} voxel(s) are both keep-in and keep-out`, [study.id]);
    const keepInCount = inside.count;
    const budget = study.volumeFraction * activeCount;
    if (keepInCount >= budget)
      return fail(
        'TOP_KEEPIN_EXCEEDS_BUDGET',
        `the keep-in regions hold ${keepInCount} of ${activeCount} voxels, the budget is ${budget} (volumeFraction ${study.volumeFraction})`,
        [study.id],
      );
    const keepOutCount = outside.count;
    return changed(
      withStudy(doc, study),
      `set_topology_regions: ${study.id} — ${study.keepIn.length} keep-in region(s) = ${keepInCount} voxels, ${study.keepOut.length} keep-out region(s) = ${keepOutCount} voxels of ${activeCount} active; budget ${budget} voxels${study.result === undefined ? '' : '; the recorded result is now stale'}.`,
      [study.id],
    );
  },
});

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

function given(value: number): NamedValue {
  return { value, source: 'set_topology_settings', defaulted: false };
}

const settingsParams = z.object({
  studyId: studyIdSchema,
  penal: z.number().optional().describe('SIMP penalisation power p, in [1, 5]. Default 3.'),
  eminRatio: z.number().optional().describe('Void stiffness as a fraction of the solid stiffness, in (0, 1). Default 1e-9.'),
  move: z.number().optional().describe('OC move limit per iteration, in (0, 1]. Default 0.2.'),
  changeTol: z.number().optional().describe('Stop when the largest design change of an iteration is at most this, > 0. Default 0.01.'),
  maxIterations: z.number().int().optional().describe('Iteration cap, 1 to 10000. Default 300.'),
  filter: z
    .object({
      kind: z.enum(['sensitivity', 'density']).optional().describe('sensitivity (default) or density filter.'),
      radius: z
        .number()
        .optional()
        .describe('Filter radius in document length units, > 0. Default 1.5 voxels. Below 1 voxel the filter does nothing.'),
    })
    .optional()
    .describe('Mesh-independence filter.'),
  threshold: z
    .number()
    .optional()
    .describe('Density at or above which a voxel counts as solid in the derived geometry, in (0, 1). Default 0.5.'),
  greyLimit: z.number().optional().describe('Mean grey level (4 x (1 - x)) above which check_topology warns, in (0, 1). Default 0.1.'),
  protectLoadSupport: z
    .boolean()
    .optional()
    .describe('Keep the voxel layer at every load and support solid. Default true; false reproduces top88.'),
  optimizer: z.enum(['oc', 'mma']).optional().describe('oc (optimality criteria, built). mma is planned and refused.'),
  manufacturing: z
    .object({
      symmetry: z
        .array(planeSchema)
        .describe('Planes through the domain centre across which the density field is mirrored in the derived geometry.'),
    })
    .optional()
    .describe('Manufacturing constraints (symmetry only in this version).'),
});

function settingsProblem(p: z.output<typeof settingsParams>): string | null {
  if (p.penal !== undefined && !(p.penal >= 1 && p.penal <= 5)) return `penal ${p.penal} must be in [1, 5]`;
  if (p.eminRatio !== undefined && !(p.eminRatio > 0 && p.eminRatio < 1)) return `eminRatio ${p.eminRatio} must be in (0, 1)`;
  if (p.move !== undefined && !(p.move > 0 && p.move <= 1)) return `move ${p.move} must be in (0, 1]`;
  if (p.changeTol !== undefined && !positive(p.changeTol)) return `changeTol ${p.changeTol} must be > 0`;
  if (p.maxIterations !== undefined && !(p.maxIterations >= 1 && p.maxIterations <= 10000))
    return `maxIterations ${p.maxIterations} must be 1 to 10000`;
  if (p.filter?.radius !== undefined && !positive(p.filter.radius)) return `filter.radius ${p.filter.radius} must be > 0`;
  if (p.threshold !== undefined && !(p.threshold > 0 && p.threshold < 1)) return `threshold ${p.threshold} must be in (0, 1)`;
  if (p.greyLimit !== undefined && !(p.greyLimit > 0 && p.greyLimit < 1)) return `greyLimit ${p.greyLimit} must be in (0, 1)`;
  if (p.optimizer === 'mma') return "optimizer 'mma' is planned (V1) and not built: use 'oc'";
  return null;
}

/**
 * @affects doc.analysis.cases[a].topology[studyId].settings / manufacturing (only the given values change)
 * @invariant each given value is stored with `defaulted: false` and source `set_topology_settings`; a recorded result reads stale when a solver setting changed
 * @failure unknown study -> TOP_STUDY_NOT_FOUND; a value out of range, nothing to change, optimizer mma -> TOP_SETUP_INVALID (unchanged doc)
 */
export const setTopologySettings = defineCommand({
  name: 'set_topology_settings',
  description:
    'Change the optimizer settings of a topology study; only the values you give change, each is stored as chosen (not a default). Ranges: penal ' +
    '[1, 5], eminRatio (0, 1), move (0, 1], changeTol > 0, maxIterations 1..10000, filter radius > 0 in document length units, threshold and greyLimit ' +
    '(0, 1). filter.kind sensitivity is the classic top88 filter (default); density gives smoother boundaries. ' +
    'protectLoadSupport false reproduces the Andreassen top88 benchmark. manufacturing.symmetry mirrors the derived geometry. A recorded result ' +
    'becomes stale when a solver setting (anything but greyLimit) changes.',
  params: settingsParams,
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string): CommandResult =>
      refuseTopology(doc, 'set_topology_settings', code, message, [params.studyId]);
    const found = findStudy(doc, params.studyId);
    if (found === undefined) return fail('TOP_STUDY_NOT_FOUND', `no topology study '${params.studyId}'`);
    const problem = settingsProblem(params);
    if (problem !== null) return fail('TOP_SETUP_INVALID', problem);
    const { studyId, manufacturing, filter, protectLoadSupport, optimizer, ...numbers } = params;
    void studyId;
    const current = found.study.settings;
    const flag = (value: boolean): NamedFlag => ({ value, source: 'set_topology_settings', defaulted: false });
    const named = (key: keyof typeof numbers, old: NamedValue): NamedValue => {
      const value = numbers[key];
      return value === undefined ? old : given(value);
    };
    const settings: TopologySettings = {
      penal: named('penal', current.penal),
      eminRatio: named('eminRatio', current.eminRatio),
      move: named('move', current.move),
      changeTol: named('changeTol', current.changeTol),
      maxIterations: named('maxIterations', current.maxIterations),
      filter: {
        kind: filter?.kind ?? current.filter.kind,
        radius: filter?.radius === undefined ? current.filter.radius : given(filter.radius),
      },
      threshold: named('threshold', current.threshold),
      greyLimit: named('greyLimit', current.greyLimit),
      protectLoadSupport: protectLoadSupport === undefined ? current.protectLoadSupport : flag(protectLoadSupport),
      optimizer: optimizer ?? current.optimizer,
    };
    const study: TopologyStudy = {
      ...found.study,
      settings,
      manufacturing: manufacturing === undefined ? found.study.manufacturing : { symmetry: [...new Set(manufacturing.symmetry)] },
    };
    if (JSON.stringify(study) === JSON.stringify(found.study))
      return fail('TOP_SETUP_INVALID', 'nothing to change: give at least one setting that differs');
    const warning =
      settings.filter.radius.value < study.voxel
        ? `; warning TOP_FILTER_TOO_SMALL: radius ${settings.filter.radius.value} is below 1 voxel (${study.voxel})`
        : '';
    return changed(
      withStudy(doc, study),
      `set_topology_settings: ${study.id} — penal ${settings.penal.value}, move ${settings.move.value}, changeTol ${settings.changeTol.value}, max ${settings.maxIterations.value} iterations, ${settings.filter.kind} filter radius ${settings.filter.radius.value} ${doc.units}, threshold ${settings.threshold.value}, protectLoadSupport ${settings.protectLoadSupport.value}${warning}.`,
      [study.id],
    );
  },
});

function withoutEntity(doc: CadDocument, entityId: string): CadDocument {
  const { [entityId]: removed, ...entities } = doc.entities;
  void removed;
  return { ...doc, entities, order: doc.order.filter((id) => id !== entityId), selection: doc.selection.filter((id) => id !== entityId) };
}

/**
 * @affects removes the study and its derived iso-surface entity (affected: [studyId, derivedEntityId?])
 * @failure unknown study -> TOP_STUDY_NOT_FOUND (unchanged doc)
 */
export const deleteTopologyStudy = defineCommand({
  name: 'delete_topology_study',
  annotations: { destructive: true },
  description:
    'Delete a topology study with its recorded result and the derived iso-surface solid. The stored field stays in the artifact store. Entities ' +
    'you modelled from suggest_rebuild are not touched.',
  params: z.object({ studyId: studyIdSchema }),
  run: (doc, { studyId }): CommandResult => {
    const found = findStudy(doc, studyId);
    if (found === undefined)
      return refuseTopology(doc, 'delete_topology_study', 'TOP_STUDY_NOT_FOUND', `no topology study '${studyId}'`, [studyId]);
    const derived = found.study.derivedEntityId;
    const next = withoutStudy(doc, found.study);
    const removedMesh = derived !== undefined && Object.hasOwn(next.entities, derived);
    return changed(
      removedMesh ? withoutEntity(next, derived) : next,
      `delete_topology_study: deleted ${studyId} '${found.study.name}'${removedMesh ? ` and its iso-surface ${derived}` : ''}.`,
      removedMesh ? [studyId, derived] : [studyId],
    );
  },
});
