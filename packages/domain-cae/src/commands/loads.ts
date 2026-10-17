/** add_fea_load / update_fea_load / delete_fea_load: mechanical loads of an analysis (force, pressure, gravity). */

import type { AnalysisCase, FeaLoad, LoadCategory } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import type { CadDocument } from '@core/model/types';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { caseOf, withCase } from '../shared/access';
import { refuseCode } from '../shared/codes';
import { loadCaseNameProblem } from '../shared/names';
import { analysisIdSchema } from '../shared/schemas';
import { feaTargetSchema, targetDistanceWarning, targetProblem, toTarget, type FeaTargetInput } from '../shared/target';

type LoadKind = 'force' | 'pressure' | 'gravity';
interface LoadFields {
  readonly target?: FeaTargetInput | undefined;
  readonly vector?: Vec3 | undefined;
  readonly magnitude?: number | undefined;
  readonly distribution?: 'total' | 'per_node' | undefined;
}

const RELEVANT: Readonly<Record<LoadKind, readonly (keyof LoadFields)[]>> = {
  force: ['target', 'vector', 'distribution'],
  pressure: ['target', 'magnitude'],
  gravity: ['vector'],
};

const UNITS_NOTE =
  'in the case unitSystem: N-mm-t-s -> N, MPa, mm/s^2 (9.81 m/s^2 = 9810); N-m-kg-s -> N, Pa, m/s^2; lbf-in-slinch-s -> lbf, psi, in/s^2';

const loadFieldsSchema = {
  target: feaTargetSchema.optional().describe('force / pressure: the faces (edges, points for force) the load acts on. Not for gravity.'),
  vector: vec3(`force / gravity: direction and magnitude [x, y, z] (${UNITS_NOTE}). Not for pressure.`).optional(),
  magnitude: z
    .number()
    .optional()
    .describe(`pressure only: positive pushes INTO the material (compressive), negative pulls (${UNITS_NOTE}).`),
  distribution: z
    .enum(['total', 'per_node'])
    .optional()
    .describe('force only: "total" (default) spreads the vector over the target; "per_node" applies it at every target node.'),
};

/** Params the kind does not use (an explicit unused param is an error, never silently dropped). */
function irrelevantParams(kind: LoadKind, fields: LoadFields): string[] {
  return (Object.keys(fields) as (keyof LoadFields)[]).filter((key) => fields[key] !== undefined && !RELEVANT[kind].includes(key));
}

function problemOf(doc: CadDocument, analysisCase: AnalysisCase, load: FeaLoad): { code: string; message: string } | null {
  const invalid = (message: string): { code: string; message: string } => ({ code: 'FEA_LOAD_INVALID', message });
  const caseProblem = loadCaseNameProblem(load.loadCase);
  if (caseProblem !== null) return invalid(caseProblem);
  if (load.kind === 'gravity') {
    if (load.vector === undefined || !load.vector.every(Number.isFinite) || load.vector.every((c) => c === 0))
      return invalid('gravity needs a non-zero finite vector');
    return null;
  }
  if (load.target === undefined) return invalid(`${load.kind} needs a target`);
  const target = targetProblem(doc, analysisCase, load.target);
  if (target !== null) return target;
  if (load.kind === 'force' && (load.vector === undefined || !load.vector.every(Number.isFinite) || load.vector.every((c) => c === 0)))
    return invalid('force needs a non-zero finite vector');
  if (load.kind === 'pressure' && (load.magnitude === undefined || !Number.isFinite(load.magnitude) || load.magnitude === 0))
    return invalid('pressure needs a non-zero finite magnitude');
  return null;
}

const summarize = (load: FeaLoad): string => {
  const value = load.kind === 'pressure' ? `p=${load.magnitude}` : `[${(load.vector ?? []).join(', ')}]`;
  return `${load.kind} ${value}, case '${load.loadCase}' (${load.category})`;
};

/**
 * @affects doc.analysis.cases[analysisId].loads (adds 1 load, id `fl-<step>.<k>`; affected: [loadId])
 * @invariant stores only the fields the kind uses; category defaults to limit and loadCase to LC1 (named in the summary)
 * @failure unknown analysis, bad target / vector / magnitude, parameter not used by the kind, moment -> refusal, unchanged doc
 */
export const addFeaLoad = defineCommand({
  name: 'add_fea_load',
  description:
    'Add a mechanical load to an analysis, returning the load id in affected[0]. kind: force (vector on target faces / edges / points; ' +
    '"total" spreads it, "per_node" applies it at each node), pressure (magnitude normal to the target faces, positive = into the ' +
    'material) or gravity (acceleration vector, no target). Magnitudes are in the unit system of the analysis (see describe_analysis, ' +
    'case.unitSystem; N-mm-t-s: N, MPa and gravity 9810 mm/s^2). loadCase groups loads solved together; category limit | ultimate ' +
    'drives later margin factors. Moments are not built. The target is given as points near the topology (see add_fea_constraint).',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z.string().min(1).describe('Display name, e.g. "tip load".'),
    kind: z.enum(['force', 'pressure', 'gravity']).describe('Load type.'),
    loadCase: z
      .string()
      .optional()
      .describe('Load case name this load belongs to: 1-40 letters, digits or underscores (e.g. "LC1", "landing_2"). Default "LC1".'),
    category: z.enum(['limit', 'ultimate']).optional().describe('limit (default) or ultimate load.'),
    ...loadFieldsSchema,
  }),
  run: (doc, { analysisId, name, kind, loadCase = 'LC1', category = 'limit', ...fields }): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [analysisId], paths: readonly string[] = []): CommandResult =>
      refuseCode(doc, 'add_fea_load', code, message, ids, paths);
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
    const unused = irrelevantParams(kind, fields);
    if (unused.length > 0) return fail('FEA_LOAD_INVALID', `${unused.join(', ')} do not apply to a ${kind} load`, [analysisId], unused);
    const load: FeaLoad = {
      id: nextId('fl'),
      name,
      loadCase,
      category: category satisfies LoadCategory,
      kind,
      ...(fields.target !== undefined ? { target: toTarget(fields.target) } : {}),
      ...(fields.vector !== undefined ? { vector: fields.vector } : {}),
      ...(fields.magnitude !== undefined ? { magnitude: fields.magnitude } : {}),
      ...(kind === 'force' ? { distribution: fields.distribution ?? 'total' } : {}),
    };
    const problem = problemOf(doc, analysisCase, load);
    if (problem !== null) return fail(problem.code, problem.message, [analysisId, ...(load.target ? [load.target.entityId] : [])]);
    const next: AnalysisCase = {
      ...analysisCase,
      loads: { ...analysisCase.loads, [load.id]: load },
      loadOrder: [...analysisCase.loadOrder, load.id],
    };
    return changed(
      withCase(doc, next),
      `add_fea_load: '${load.id}' (${name}) ${summarize(load)} in '${analysisId}'.${load.target ? targetDistanceWarning(doc, load.target) : ''}`,
      [load.id],
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].loads[loadId] (given fields replaced; the kind never changes)
 * @failure unknown analysis / load, parameter not used by the load's kind, invalid result -> refusal, unchanged doc
 */
export const updateFeaLoad = defineCommand({
  name: 'update_fea_load',
  description:
    'Change an existing load: name, loadCase, category, target, vector, magnitude or distribution. Only the given fields change; the kind ' +
    'cannot change (delete and add instead); a field the kind does not use is refused. The result is validated like add_fea_load.',
  params: z.object({
    analysisId: analysisIdSchema,
    loadId: z.string().describe('Load id (affected[0] of add_fea_load, or see describe_analysis).'),
    name: z.string().min(1).optional().describe('New display name.'),
    loadCase: z.string().optional().describe('New load case name: 1-40 letters, digits or underscores.'),
    category: z.enum(['limit', 'ultimate']).optional().describe('New category.'),
    ...loadFieldsSchema,
  }),
  run: (doc, { analysisId, loadId, name, loadCase, category, ...fields }): CommandResult => {
    const fail = (
      code: string,
      message: string,
      ids: readonly string[] = [analysisId, loadId],
      paths: readonly string[] = [],
    ): CommandResult => refuseCode(doc, 'update_fea_load', code, message, ids, paths);
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
    const existing = Object.hasOwn(analysisCase.loads, loadId) ? analysisCase.loads[loadId] : undefined;
    if (existing === undefined) return fail('FEA_LOAD_NOT_FOUND', `no load '${loadId}' in '${analysisId}'`);
    if (existing.kind === 'moment') return fail('FEA_LOAD_INVALID', 'moment loads are not built');
    const unused = irrelevantParams(existing.kind, fields);
    if (unused.length > 0)
      return fail('FEA_LOAD_INVALID', `${unused.join(', ')} do not apply to a ${existing.kind} load`, undefined, unused);
    const updated: FeaLoad = {
      ...existing,
      ...(name !== undefined ? { name } : {}),
      ...(loadCase !== undefined ? { loadCase } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(fields.target !== undefined ? { target: toTarget(fields.target) } : {}),
      ...(fields.vector !== undefined ? { vector: fields.vector } : {}),
      ...(fields.magnitude !== undefined ? { magnitude: fields.magnitude } : {}),
      ...(fields.distribution !== undefined ? { distribution: fields.distribution } : {}),
    };
    const problem = problemOf(doc, analysisCase, updated);
    if (problem !== null) return fail(problem.code, problem.message);
    const next: AnalysisCase = { ...analysisCase, loads: { ...analysisCase.loads, [loadId]: updated } };
    return changed(withCase(doc, next), `update_fea_load: '${loadId}' (${updated.name}) now ${summarize(updated)} in '${analysisId}'.`, [
      loadId,
    ]);
  },
});

/**
 * @affects doc.analysis.cases[analysisId].loads (removes 1; affected: [loadId])
 * @failure unknown analysis / load -> refusal, unchanged doc
 */
export const deleteFeaLoad = defineCommand({
  name: 'delete_fea_load',
  description: 'Remove a load from an analysis.',
  annotations: { destructive: true },
  params: z.object({ analysisId: analysisIdSchema, loadId: z.string().describe('Load id to remove.') }),
  run: (doc, { analysisId, loadId }): CommandResult => {
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseCode(doc, 'delete_fea_load', 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
    if (!Object.hasOwn(analysisCase.loads, loadId))
      return refuseCode(doc, 'delete_fea_load', 'FEA_LOAD_NOT_FOUND', `no load '${loadId}' in '${analysisId}'`, [analysisId, loadId]);
    const next: AnalysisCase = {
      ...analysisCase,
      loads: Object.fromEntries(Object.entries(analysisCase.loads).filter(([id]) => id !== loadId)),
      loadOrder: analysisCase.loadOrder.filter((id) => id !== loadId),
    };
    return changed(withCase(doc, next), `delete_fea_load: removed '${loadId}' from '${analysisId}'.`, [loadId]);
  },
});
