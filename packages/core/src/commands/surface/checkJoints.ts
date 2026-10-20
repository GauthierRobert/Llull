/** check_continuity and measure_deviation: read-only checks of how well curves / sheets join, and how far a shape lies from another. */

import type { Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { report } from '../noop';
import { surfacePoleExtent } from '../../geometry/nurbsSurface';
import { poleExtent } from '../../geometry/nurbsCurve';
import { resolveSurfaceAnalysis } from '../../geometry/surfaceAnalysis/port';
import type {
  ContinuityEdge,
  ContinuityJoint,
  ContinuityOrder,
  ContinuityTolerances,
  DeviationShape,
  SurfaceAnalysisEngine,
  SurfaceSide,
} from '../../geometry/surfaceAnalysis/types';
import { currentContext } from '../context';
import { refuseSrf } from './shared';
import { analysisTarget, isRefusal, sig, sigVec, type AnalysisTarget } from './surfaceShared';

const SIDES = ['u0', 'u1', 'v0', 'v1'] as const;
const ORDERS: ReadonlyArray<ContinuityOrder> = ['none', 'G0', 'G1', 'G2', 'G3'];
const MAX_PAIRS = 50;
const MAX_SAMPLES = 201;

const sideField = z
  .enum(SIDES)
  .describe(
    'Boundary edge of a nurbs_surface: "u0" / "u1" = the edge at the lowest / highest u (a curve running along v), "v0" / "v1" = the edge at the lowest / highest v. Omit to detect it (the side pair that meets best).',
  )
  .optional();

const endpoint = z.object({ id: z.string().describe('Id of a nurbs_curve or a nurbs_surface entity.'), side: sideField });

/** Largest extent of an entity's pole box (document units): the model size the default tolerances scale with. */
function sizeOf(target: AnalysisTarget): number {
  const extent =
    target.shape.type === 'surface'
      ? surfacePoleExtent(target.shape.surface)
      : target.shape.type === 'curve'
        ? poleExtent(target.shape.curve)
        : null;
  return extent === null ? 1 : Math.max(extent.max[0] - extent.min[0], extent.max[1] - extent.min[1], extent.max[2] - extent.min[2], 1e-9);
}

function edgeOf(target: AnalysisTarget, side: SurfaceSide): ContinuityEdge {
  return target.shape.type === 'surface'
    ? { type: 'surface', surface: target.shape.surface, side }
    : { type: 'curve', curve: (target.shape as Extract<DeviationShape, { type: 'curve' }>).curve };
}

/** The sides to try for one end of a pair: the given one, or all four for a patch, or just the curve. */
const sidesFor = (target: AnalysisTarget, side: SurfaceSide | undefined): ReadonlyArray<SurfaceSide> =>
  target.shape.type !== 'surface' ? ['u0'] : side === undefined ? SIDES : [side];

/** The joint of the best side pair (smallest mean gap over a few samples), then re-evaluated with `samples`. */
function bestJoint(
  engine: SurfaceAnalysisEngine,
  a: AnalysisTarget,
  b: AnalysisTarget,
  sideA: SurfaceSide | undefined,
  sideB: SurfaceSide | undefined,
  samples: number,
  tolerances: ContinuityTolerances,
): { joint: ContinuityJoint; sideA: SurfaceSide; sideB: SurfaceSide } {
  let best: { sideA: SurfaceSide; sideB: SurfaceSide; score: number } | null = null;
  for (const candidateA of sidesFor(a, sideA))
    for (const candidateB of sidesFor(b, sideB)) {
      const probe = engine.continuity(edgeOf(a, candidateA), edgeOf(b, candidateB), 5, tolerances);
      const score = probe.samples.length === 0 ? Infinity : probe.samples.reduce((sum, s) => sum + s.g0Gap, 0) / probe.samples.length;
      if (best === null || score < best.score) best = { sideA: candidateA, sideB: candidateB, score };
    }
  const chosen = best as NonNullable<typeof best>;
  return {
    joint: engine.continuity(edgeOf(a, chosen.sideA), edgeOf(b, chosen.sideB), samples, tolerances),
    sideA: chosen.sideA,
    sideB: chosen.sideB,
  };
}

/**
 * @affects none; data = { joints [{ a, b, g0Gap, g1AngleRad, g1AngleDeg, g2Gap, g2Rel, g3Gap?, order, pass, worst, samples? }], minOrder, pass, tolerances, unit, engine, provenance }
 * @invariant order = highest G-level whose measures are all within tolerance; surfaces are measured to G2, curves to G3
 * @failure unknown id -> SRF_ENTITY_NOT_FOUND; a solid / 2D shape -> SRF_NOT_ANALYSABLE; a curve paired with a surface -> SRF_CONTINUITY_MISMATCH; bad samples -> SRF_PARAM_INVALID
 */
export const checkContinuity = defineCommand({
  name: 'check_continuity',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only geometric continuity of joints, in numbers (not a picture). Each pair joins two nurbs_curve entities (the nearest pair of ends is ' +
    'compared) or two nurbs_surface entities (one boundary edge of each, `side` "u0" | "u1" | "v0" | "v1", detected when omitted; sampled ' +
    '`samples` times along the first edge). Measured: G0 position gap (document units); G1 angle between tangents / surface normals (radians); ' +
    'G2 jump of curvature (curves: the curvature vectors; surfaces: the normal curvature across the edge) with its relative size; for curves ' +
    'G3 the jump of d(curvature)/ds. `order` is the highest level within tolerance: "none", "G0", "G1", "G2" or "G3". Tolerances default to ' +
    'g0 = 1e-6 x the size of the entities, g1AngleRad 0.01 rad, g2Rel 0.1 (10 %), g2Abs 1e-9, g3Rel 0.1 and are reported with the names that ' +
    'were defaulted. `require` makes `pass` false unless every joint reaches that order. Reference: a corner is G0, line + tangent arc G1, ' +
    'line + y=x^3 G2, line + y=x^4 G3.',
  params: z.object({
    pairs: z
      .array(
        z.object({
          a: endpoint.describe('First entity of the joint (and its boundary edge for a surface).'),
          b: endpoint.describe('Second entity of the joint.'),
        }),
      )
      .describe('1..50 joints to check, each between entity `a` and entity `b`.'),
    samples: z
      .number()
      .describe('Samples along a surface edge, integer 2..201. Default 21. Curve joints are measured at the joint only.')
      .optional(),
    require: z.enum(['G0', 'G1', 'G2', 'G3']).describe('Order every joint must reach for `pass`. Default "G1".').optional(),
    g0: z.number().describe('Largest position gap still counted as G0, document units (> 0). Default 1e-6 x the entity size.').optional(),
    g1AngleRad: z.number().describe('Largest angle still counted as G1, radians (> 0). Default 0.01.').optional(),
    g2Rel: z.number().describe('Largest relative curvature jump still counted as G2 (> 0). Default 0.1.').optional(),
    g2Abs: z
      .number()
      .describe('Curvature difference (1/document unit) below which two curvatures count as equal (>= 0). Default 1e-9.')
      .optional(),
    g3Rel: z.number().describe('Largest relative jump of d(curvature)/ds still counted as G3 (> 0). Default 0.1.').optional(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { pairs, samples = 21, require = 'G1' } = params;
    const invalid = (message: string, path: string): CommandResult =>
      refuseSrf(doc, 'check_continuity', 'SRF_PARAM_INVALID', message, [], [`params.${path}`]);
    if (pairs.length === 0 || pairs.length > MAX_PAIRS) return invalid(`pairs needs 1..${MAX_PAIRS} joints`, 'pairs');
    if (!(Number.isInteger(samples) && samples >= 2 && samples <= MAX_SAMPLES))
      return invalid(`samples must be an integer in 2..${MAX_SAMPLES} (got ${samples})`, 'samples');
    for (const name of ['g0', 'g1AngleRad', 'g2Rel', 'g3Rel'] as const)
      if (params[name] !== undefined && !((params[name] as number) > 0)) return invalid(`${name} must be > 0`, name);
    if (params.g2Abs !== undefined && !(params.g2Abs >= 0)) return invalid('g2Abs must be >= 0', 'g2Abs');
    const engine = resolveSurfaceAnalysis((ctx ?? currentContext()).surfaceAnalysis);
    const results: Array<Record<string, unknown>> = [];
    let minOrder = 4;
    let size = 0;
    const defaulted: string[] = [];
    for (const [index, pair] of pairs.entries()) {
      const [a, b] = [
        analysisTarget(doc, 'check_continuity', pair.a.id, `pairs.${index}.a.id`),
        analysisTarget(doc, 'check_continuity', pair.b.id, `pairs.${index}.b.id`),
      ];
      if (isRefusal(a)) return a;
      if (isRefusal(b)) return b;
      if (!['surface', 'curve'].includes(a.shape.type) || !['surface', 'curve'].includes(b.shape.type))
        return refuseSrf(
          doc,
          'check_continuity',
          'SRF_NOT_ANALYSABLE',
          'continuity is measured between curves or between surface sheets',
          [pair.a.id, pair.b.id],
          [`pairs.${index}`],
        );
      if (a.shape.type !== b.shape.type)
        return refuseSrf(
          doc,
          'check_continuity',
          'SRF_CONTINUITY_MISMATCH',
          `pair ${index} joins a ${a.shape.type} to a ${b.shape.type}`,
          [pair.a.id, pair.b.id],
          [`pairs.${index}`],
        );
      size = Math.max(size, sizeOf(a), sizeOf(b));
      const tolerances: ContinuityTolerances = {
        g0: params.g0 ?? 1e-6 * Math.max(sizeOf(a), sizeOf(b)),
        g1AngleRad: params.g1AngleRad ?? 0.01,
        g2Rel: params.g2Rel ?? 0.1,
        g2Abs: params.g2Abs ?? 1e-9,
        g3Rel: params.g3Rel ?? 0.1,
      };
      const { joint, sideA, sideB } = bestJoint(engine, a, b, pair.a.side, pair.b.side, samples, tolerances);
      if (index === 0)
        for (const name of ['g0', 'g1AngleRad', 'g2Rel', 'g2Abs', 'g3Rel'] as const) if (params[name] === undefined) defaulted.push(name);
      const order = ORDERS.indexOf(joint.order);
      minOrder = Math.min(minOrder, order);
      results.push({
        a: { id: pair.a.id, ...(a.shape.type === 'surface' ? { side: sideA } : {}) },
        b: { id: pair.b.id, ...(b.shape.type === 'surface' ? { side: sideB } : {}) },
        type: a.shape.type,
        g0Gap: sig(joint.g0Gap),
        g1AngleRad: sig(joint.g1AngleRad),
        g1AngleDeg: sig((joint.g1AngleRad * 180) / Math.PI),
        g2Gap: sig(joint.g2Gap),
        g2Rel: sig(joint.g2Rel),
        ...(joint.g3Gap === null ? {} : { g3Gap: sig(joint.g3Gap) }),
        order: joint.order,
        pass: order >= ORDERS.indexOf(require),
        worst: { t: sig(joint.worst.t), point: sigVec(joint.worst.point) },
        ...(joint.samples.length <= 51
          ? {
              samples: joint.samples.map((s) => ({
                t: sig(s.t),
                point: sigVec(s.point),
                g0Gap: sig(s.g0Gap),
                g1AngleRad: sig(s.g1AngleRad),
                g2Gap: sig(s.g2Gap),
              })),
            }
          : {}),
      });
    }
    const pass = results.every((joint) => joint['pass'] === true);
    const data = {
      joints: results,
      minOrder: ORDERS[minOrder],
      require,
      pass,
      tolerances: {
        g0: params.g0 ?? 'default 1e-6 x entity size',
        g1AngleRad: params.g1AngleRad ?? 0.01,
        g2Rel: params.g2Rel ?? 0.1,
        g2Abs: params.g2Abs ?? 1e-9,
        g3Rel: params.g3Rel ?? 0.1,
        defaulted,
      },
      unit: doc.units,
      engine: engine.provenance.engine,
      unverified: false,
      provenance: {
        method:
          'exact NURBS derivatives at the joint; surfaces: foot-point projection onto the other edge, normal curvature across the edge',
        reference: 'Farin, Curves and Surfaces for CAGD; OCC LocalAnalysis_SurfaceContinuity (G0-G2 definitions)',
        inputs: { pairs: pairs.length, samples },
      },
    };
    return report(
      doc,
      `check_continuity: ${results.length} joint(s), lowest order ${ORDERS[minOrder]}, required ${require} -> ${pass ? 'PASS' : 'FAIL'}` +
        (results.length === 1
          ? ` (G0 gap ${(results[0] as { g0Gap: number }).g0Gap} ${doc.units}, G1 ${(results[0] as { g1AngleRad: number }).g1AngleRad} rad).`
          : '.'),
      data,
    );
  },
});

const DEVIATION_SAMPLES = 25;

/**
 * @affects none; data = { id, source, count, max, mean, rms, p95, worst, signed?, histogram, tolerance?, pass?, unit, provenance }
 * @invariant one-way distance from the source samples to the target shape (>= 0); a surface target also reports it signed along the normal
 * @failure unknown id -> SRF_ENTITY_NOT_FOUND; neither `points` nor `referenceId`, or both -> SRF_PARAM_INVALID; a point-cloud / curve-less target -> SRF_NOT_ANALYSABLE
 */
export const measureDeviation = defineCommand({
  name: 'measure_deviation',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only deviation of measured points, or of another entity, from a target shape. `id` is the TARGET: a nurbs_surface, a nurbs_curve or ' +
    'a 3D solid (its tessellation). The source is either `points` (a measured cloud, document units, world coordinates) or `referenceId` ' +
    '(a nurbs_surface sampled on `samples` x `samples` points, a nurbs_curve sampled `samples` times, or a solid: its vertices). Every source point ' +
    'is projected on the target (Newton foot point on NURBS; closest triangle on a solid): returns max, mean, rms, the 95th percentile, the ' +
    'worst point and its foot, a 10-bin histogram, and for a surface target the distance signed along its normal. Reference: a sphere of ' +
    'radius 10 against points on radius 10.5 gives max = mean = rms = 0.5. With `tolerance`, `pass` is true when max <= tolerance. One-way: ' +
    'swap the roles to measure the other direction.',
  params: z.object({
    id: z.string().describe('Id of the target: a nurbs_surface, a nurbs_curve or a 3D solid.'),
    points: z
      .array(vec3('Measured point [x, y, z] in document units (world coordinates).'))
      .describe('Measured points to compare with the target (1..20000). Give this or `referenceId`.')
      .optional(),
    referenceId: z
      .string()
      .describe(
        'Id of the entity whose samples are compared with the target (nurbs_surface, nurbs_curve or 3D solid). Give this or `points`.',
      )
      .optional(),
    samples: z
      .number()
      .describe('Samples per direction (surface) or along a curve for `referenceId`, integer 2..200. Default 25.')
      .optional(),
    tolerance: z.number().describe('Largest acceptable maximum deviation, document units (> 0). Adds a `pass` verdict.').optional(),
  }),
  run: (doc, { id, points, referenceId, samples = DEVIATION_SAMPLES, tolerance }, ctx): CommandResult => {
    const invalid = (message: string, path: string): CommandResult =>
      refuseSrf(doc, 'measure_deviation', 'SRF_PARAM_INVALID', message, [id], [`params.${path}`]);
    if ((points === undefined) === (referenceId === undefined)) return invalid('give exactly one of `points` and `referenceId`', 'points');
    if (points !== undefined && (points.length === 0 || points.length > 20_000)) return invalid('points needs 1..20000 entries', 'points');
    if (!(Number.isInteger(samples) && samples >= 2 && samples <= 200))
      return invalid(`samples must be an integer in 2..200 (got ${samples})`, 'samples');
    if (tolerance !== undefined && !(tolerance > 0)) return invalid('tolerance must be > 0', 'tolerance');
    const target = analysisTarget(doc, 'measure_deviation', id);
    if (isRefusal(target)) return target;
    if (target.shape.type === 'points') return invalid('the target cannot be a point cloud', 'id');
    let from: DeviationShape;
    if (points !== undefined) from = { type: 'points', points: points as Vec3[] };
    else {
      const reference = analysisTarget(doc, 'measure_deviation', referenceId as string, 'referenceId');
      if (isRefusal(reference)) return reference;
      from = reference.shape;
    }
    const engine = resolveSurfaceAnalysis((ctx ?? currentContext()).surfaceAnalysis);
    const result = engine.deviation({ from, to: target.shape as Exclude<DeviationShape, { type: 'points' }>, samples });
    if (result.count === 0)
      return invalid(`nothing to measure: "${referenceId ?? 'points'}" gave no samples or the target is empty`, 'referenceId');
    const pass = tolerance === undefined ? undefined : result.max <= tolerance;
    const data = {
      id,
      source: points !== undefined ? 'points' : `entity ${referenceId}`,
      targetType: target.shape.type,
      count: result.count,
      max: sig(result.max),
      mean: sig(result.mean),
      rms: sig(result.rms),
      p95: sig(result.p95),
      worst: { point: sigVec(result.worst.point), foot: sigVec(result.worst.foot), distance: sig(result.worst.distance) },
      ...(result.signed === null
        ? {}
        : { signed: { mean: sig(result.signed.mean), min: sig(result.signed.min), max: sig(result.signed.max) } }),
      histogram: result.histogram,
      histogramBinWidth: sig(result.max / 10),
      ...(tolerance === undefined ? {} : { tolerance, pass }),
      unit: doc.units,
      engine: engine.provenance.engine,
      unverified: false,
      provenance: {
        method: 'one-way distance from the source samples to the target (Newton foot point on NURBS, closest triangle point on meshes)',
        reference: 'Piegl & Tiller, The NURBS Book, §6.1 point projection',
        inputs: { id, referenceId: referenceId ?? null, samples: result.count },
      },
    };
    return report(
      doc,
      `measure_deviation ${id}: ${result.count} samples, max ${data.max} ${doc.units}, mean ${data.mean}, rms ${data.rms}` +
        (pass === undefined ? '.' : `; tolerance ${tolerance} -> ${pass ? 'PASS' : 'FAIL'}.`),
      data,
    );
  },
});
