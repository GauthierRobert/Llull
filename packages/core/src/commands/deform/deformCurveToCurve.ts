/** deform_curve_to_curve — deform a body so that chosen curves of it land on target curves (01 DEF M5, FR-DEF-18, Rhino CurveShape / CATIA Deform by curves). */

import type { Vec3 } from '../../model/types';
import { MAX_RBF_CENTRES, type RbfConstraint, fitRbf, rbfMap, samplesByArcLength } from '../../geometry/deform/rbf';
import { worldCurve } from '../../geometry/deform/worldNurbs';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { bodyParams, outputParam, targetIds } from './schema';
import type { DeformPlan } from './request';
import { runDeform } from './run';
import { type Refusal, resolveTargetFrame } from './target';

/** Samples per curve unless asked otherwise. */
const DEFAULT_SAMPLES = 24;

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * @affects replaces the entity by a mesh entity whose brep recipe is a deform node with a displacement-field law (centres, weights, affine part)
 * @invariant with stiffness 0 the field carries every sample of an initial curve onto the sample of its target at the same arc-length fraction, and the residual
 *   between the samples is reported (data.landing); a pair without target stays where it is; fixedPoints do not move; kernel-optional: exact warp on the native kernel,
 *   mesh path otherwise
 * @failure every curve already on its target -> DEF_NO_EFFECT; a pair curve missing or not a nurbs_curve, no pair, too many samples, or coincident constraints with different data -> DEF_CURVE_PAIR_INVALID; a residual above
 *   landingTolerance -> DEF_APPROX_TOLERANCE; det J <= 0 in the body -> DEF_FOLDOVER
 */
export const deformCurveToCurve = defineCommand({
  name: 'deform_curve_to_curve',
  annotations: { readsMeshTriangles: true },
  description:
    'Deform a 3D solid or mesh by dragging curves: each pair names an initial nurbs_curve (lying on or near the body) and the target nurbs_curve it must land on. The curves are sampled at ' +
    'equal fractions of their arc length (samples per curve), and a smooth displacement field (a triharmonic spline, C2, no folds for moderate moves) that carries the initial samples onto ' +
    'the target samples is applied to the whole body. A pair without targetId keeps its curve where it is (a constraint that holds a part of the body still), and fixedPoints hold ' +
    'single points. stiffness 0..1 relaxes the fit (0: the curves land exactly; larger: a stiffer body that only approaches the targets). data.landing reports the largest ' +
    'distance, document units, between the mapped initial curve and its target (checked between the samples), refused above landingTolerance (default 1 percent of the size of the constraints). ' +
    'The result replaces the entity as a mesh entity that keeps the construction (brep recipe). Refuses a missing or non-curve entity in a pair (DEF_CURVE_PAIR_INVALID), a residual ' +
    'above the tolerance (DEF_APPROX_TOLERANCE: more samples or a lower stiffness) and a field that folds the body (DEF_FOLDOVER). Then call analyze_deformation and check_deformation.',
  params: z.object({
    ...bodyParams,
    pairs: z
      .array(
        z.object({
          initialId: z.string().describe('Id of the nurbs_curve to move (on or near the body).'),
          targetId: z.string().describe('Id of the nurbs_curve it must land on. Omit to hold the initial curve in place.').optional(),
        }),
      )
      .min(1)
      .max(50)
      .describe(
        'Curve pairs; each initial curve is carried onto its target (matching points by arc-length fraction, so give them the same direction).',
      ),
    fixedPoints: z
      .array(vec3('A world point that must not move, document units.'))
      .max(100)
      .describe('Points of the body held still. Default none.')
      .optional(),
    stiffness: z
      .number()
      .describe('Relaxation of the fit, 0..1: 0 lands the curves exactly (default); larger values give a stiffer, smoother field.')
      .optional(),
    samples: z.number().describe('Samples per curve, integer 4..200 (default 24); more samples follow wiggly curves closer.').optional(),
    landingTolerance: z
      .number()
      .describe(
        'Largest accepted distance between a mapped initial curve and its target, document units, > 0. Default: 1 percent of the diagonal of the constraint points.',
      )
      .optional(),
    output: outputParam.optional(),
  }),
  run: (
    doc,
    { id, ids, keepSource, pairs, fixedPoints = [], stiffness = 0, samples = DEFAULT_SAMPLES, landingTolerance, output },
    ctx,
  ): CommandResult =>
    runDeform(doc, ctx, {
      command: 'deform_curve_to_curve',
      ids: targetIds(id, ids),
      keepSource,
      verb: 'deformed by curves',
      output,
      plan: (target): DeformPlan | Refusal => {
        const invalid = (message: string, path: string): Refusal => ({
          code: 'DEF_CURVE_PAIR_INVALID',
          message,
          paths: [`params.${path}`],
        });
        if (!Number.isInteger(samples) || samples < 4 || samples > 200)
          return invalid(`samples ${samples} must be an integer in 4..200`, 'samples');
        if (!(stiffness >= 0 && stiffness <= 1)) return invalid(`stiffness ${stiffness} must lie in 0..1`, 'stiffness');
        const constraints: RbfConstraint[] = [];
        const landing: Array<{ initial: Vec3[]; target: Vec3[] }> = [];
        for (const [position, pair] of pairs.entries()) {
          const initial = doc.entities[pair.initialId];
          const goal = pair.targetId === undefined ? undefined : doc.entities[pair.targetId];
          if (initial?.kind !== 'nurbs_curve') return invalid(`'${pair.initialId}' is not a nurbs_curve`, `pairs.${position}.initialId`);
          if (pair.targetId !== undefined && goal?.kind !== 'nurbs_curve')
            return invalid(`'${pair.targetId}' is not a nurbs_curve`, `pairs.${position}.targetId`);
          const from = samplesByArcLength(worldCurve(initial), samples);
          const to = goal?.kind === 'nurbs_curve' ? samplesByArcLength(worldCurve(goal), samples) : from;
          from.forEach((at, k) => {
            const end = to[k] as Vec3;
            constraints.push({ at, delta: [end[0] - at[0], end[1] - at[1], end[2] - at[2]] });
          });
          landing.push({
            initial: samplesByArcLength(worldCurve(initial), 2 * samples - 1),
            target: goal?.kind === 'nurbs_curve' ? samplesByArcLength(worldCurve(goal), 2 * samples - 1) : [],
          });
        }
        for (const at of fixedPoints) constraints.push({ at, delta: [0, 0, 0] });
        if (constraints.length > MAX_RBF_CENTRES)
          return invalid(
            `${constraints.length} constraints exceed the limit of ${MAX_RBF_CENTRES}: lower samples or the number of pairs`,
            'samples',
          );
        const low = [Infinity, Infinity, Infinity];
        const high = [-Infinity, -Infinity, -Infinity];
        for (const { at, delta } of constraints)
          for (let a = 0; a < 3; a++) {
            low[a] = Math.min(low[a] as number, at[a] as number, (at[a] as number) + (delta[a] as number));
            high[a] = Math.max(high[a] as number, at[a] as number, (at[a] as number) + (delta[a] as number));
          }
        const size = Math.hypot(
          (high[0] as number) - (low[0] as number),
          (high[1] as number) - (low[1] as number),
          (high[2] as number) - (low[2] as number),
        );
        if (constraints.every(({ delta }) => Math.hypot(delta[0], delta[1], delta[2]) <= 1e-12 * (1 + size)))
          return { code: 'DEF_NO_EFFECT', message: 'every curve already lies on its target: nothing moves', paths: ['params.pairs'] };
        const law = fitRbf(constraints, (stiffness * size) / constraints.length);
        if (law === null)
          return invalid(
            'the curve constraints are inconsistent (two curves touch with different targets, or coincide): separate them or drop one pair',
            'pairs',
          );
        const residual = landing.reduce(
          (worst, { initial, target: goal }) =>
            goal.length === 0
              ? worst
              : initial.reduce((sum, point, k) => Math.max(sum, distance(rbfMap(law, point), goal[k] as Vec3)), worst),
          0,
        );
        const accepted = landingTolerance ?? 0.01 * size;
        if (!(accepted > 0)) return invalid(`landingTolerance ${accepted} must be > 0`, 'landingTolerance');
        if (residual > accepted)
          return {
            code: 'DEF_APPROX_TOLERANCE',
            message: `the curves land ${residual.toPrecision(4)} ${doc.units} from their targets (allowed ${accepted.toPrecision(4)}): raise samples, lower stiffness or accept a larger landingTolerance`,
            paths: ['params.samples'],
          };
        const resolved = resolveTargetFrame(target, { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] }, 'centre');
        if ('code' in resolved) return resolved;
        return {
          law,
          frame: resolved.frame,
          extent: resolved.extent,
          defaulted: [],
          report: { landing: { maxDistance: residual, allowed: accepted, unit: doc.units }, constraints: constraints.length },
        };
      },
    }),
});
