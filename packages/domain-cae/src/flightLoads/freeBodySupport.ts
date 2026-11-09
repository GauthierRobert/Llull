/** set_free_body_support: the 3-2-1 statically determinate support of an inertial-relief (free-flight) analysis. */

import type { AnalysisCase, FeaConstraint } from '@core/model/analysis';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { caseOf, withCase } from '../shared/access';
import { analysisIdSchema } from '../shared/schemas';
import { targetDistanceWarning, targetProblem } from '../shared/target';
import { refuseFll } from './codes';
import { bestSupportPattern } from './supportPattern';

/** Closest two support points may be, as a share of their spread (below it two of them snap to one node). */
const MIN_POINT_SEPARATION = 1e-6;

/**
 * @affects doc.analysis.cases[analysisId].constraints (adds 3 displacement constraints `fc-<step>.<k>` flagged freeBody; affected: [fc1, fc2, fc3])
 * @invariant the three constraints hold ux uy uz at point 1, two dofs at point 2 and one at point 3, chosen so the 6 x 6 rigid-body restraint matrix is full rank
 *   (pivot >= 0.05 of the point spread); with them and a balanced load set a static solve has zero reactions (check_analysis FLL_RELIEF_RESIDUAL)
 * @failure unknown analysis / non-static type / entity not a part / existing constraints / coincident, collinear or near-collinear points -> refusal, unchanged doc
 */
export const setFreeBodySupport = defineCommand({
  name: 'set_free_body_support',
  description:
    'Inertial-relief support of a free body (14 FLL): three statically determinate point supports (3-2-1) that remove exactly the six rigid-body ' +
    'motions without constraining the deformation, for a static analysis loaded by export_flight_loads (mount forces balanced by the inertial ' +
    'body force). Give three points [x, y, z] (document units) on the part, far apart and not collinear: point 1 holds ux uy uz, point 2 two ' +
    'translations, point 3 one; the dofs are chosen automatically as the best-conditioned of the nine possible patterns and returned in the summary. ' +
    'The supports are displacement constraints flagged freeBody, listed by describe_analysis; with a balanced load case their reactions vanish, ' +
    'and check_analysis reports FLL_RELIEF_RESIDUAL when they do not (reaction above 1e-4 of the applied load). The analysis must have no other ' +
    'constraint (FLL_SUPPORT_CONFLICT). Returns the three constraint ids in affected.',
  params: z.object({
    analysisId: analysisIdSchema,
    entityId: z
      .string()
      .describe('Id of the analysed 3D part the supports act on (it must be a part of the analysis: set_part_idealization).'),
    points: z
      .tuple([
        vec3('Support point 1 [x, y, z] in document units: holds all three translations.'),
        vec3('Support point 2: holds two translations.'),
        vec3('Support point 3: holds one translation.'),
      ])
      .describe('Exactly three points on the part, far apart and not collinear (the mesh nodes nearest to them are held).'),
    name: z.string().min(1).optional().describe('Name prefix of the three constraints. Default "free-body".'),
  }),
  run: (doc, { analysisId, entityId, points, name = 'free-body' }): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [analysisId], paths: readonly string[] = []): CommandResult =>
      refuseFll(doc, 'set_free_body_support', code, message, ids, paths);
    const analysis = caseOf(doc, analysisId);
    if (analysis === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
    if (analysis.type !== 'static') return fail('FLL_ANALYSIS_TYPE', `analysis '${analysisId}' is ${analysis.type}, not static`);
    if (analysis.constraintOrder.length > 0)
      return fail('FLL_SUPPORT_CONFLICT', `analysis '${analysisId}' already has ${analysis.constraintOrder.length} constraint(s)`);
    const triple = points;
    const spread = Math.max(...triple.flatMap((p, i) => triple.slice(i + 1).map((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))));
    const closest = Math.min(
      ...triple.flatMap((p, i) => triple.slice(i + 1).map((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))),
    );
    if (!(spread > 0) || closest < MIN_POINT_SEPARATION * spread)
      return fail('FLL_SUPPORT_POINTS', 'two support points coincide', [analysisId], ['points']);
    for (const [index, point] of triple.entries()) {
      const problem = targetProblem(doc, analysis, { entityId, pointsNear: [point] });
      if (problem !== null) return fail(problem.code, `point ${index + 1}: ${problem.message}`, [analysisId, entityId], ['entityId']);
    }
    const pattern = bestSupportPattern(triple);
    if (pattern === null)
      return fail(
        'FLL_SUPPORT_SINGULAR',
        'the three points are collinear or nearly so: no 3-2-1 pattern removes all six rigid-body motions',
        [analysisId],
        ['points'],
      );
    const constraints = triple.map(
      (point, index): FeaConstraint => ({
        id: nextId('fc'),
        name: `${name} P${index + 1}`,
        kind: 'displacement',
        dofs: Object.fromEntries((pattern.dofs[index] ?? []).map((dof) => [dof, 0])),
        target: { entityId, pointsNear: [point] },
        freeBody: true,
      }),
    );
    const next: AnalysisCase = {
      ...analysis,
      constraints: { ...analysis.constraints, ...Object.fromEntries(constraints.map((constraint) => [constraint.id, constraint])) },
      constraintOrder: [...analysis.constraintOrder, ...constraints.map((constraint) => constraint.id)],
    };
    const held = constraints.map((constraint) => `${constraint.id} holds ${Object.keys(constraint.dofs ?? {}).join(' ')}`).join('; ');
    const warnings = constraints.map((constraint) => targetDistanceWarning(doc, constraint.target)).join('');
    return changed(
      withCase(doc, next),
      `set_free_body_support: 3-2-1 support on '${entityId}' in '${analysisId}': ${held} (conditioning ${Number(pattern.conditioning.toPrecision(3))}).${warnings}`,
      constraints.map((constraint) => constraint.id),
    );
  },
});
