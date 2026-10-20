/** check_motion_clearance: read-only collision and minimum-clearance check of a mechanism over a simulated run. */

import type { CadDocument } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import { defineCommand, z } from '../schema';
import { codedRejection, noop, rejection, report } from '../noop';
import { currentContext } from '../context';
import { MM_PER_UNIT } from '../../model/units';
import { checkedPrototype } from '../../model/prototype';
import { type CheckItem, type CheckResult, worstStatus } from '../../model/checkResult';
import type { SimulationData } from '../../dynamics/simulationReport';
import { isMoving } from '../../dynamics/motionPoses';
import { hashText } from '../../lib/hash';
import { canonicalJson } from '../../lib/canonicalJson';
import { roundDeep } from '../../lib/significant';
import { recipeKey } from '../../geometry/shapeRecipe';
import { candidateIds, collectParts } from '../inspect/assemblyParts';
import { assemblyLinks } from '../inspect/assemblyGraph';
import { dynamicsOf } from './bodies';
import { simulateMotion } from './simulate';
import { MAX_CLASSIFIED_TOTAL, MAX_EVALUATIONS, planMotion, runMotion } from './motionClearanceRun';

const MAX_PARTS = 500;
const MAX_PAIRS = 2000;
const MAX_PAIR_SAMPLES = 400_000;
const DEFAULT_TOUCH_MM = 0.001;
const DEFAULT_DURATION = 2;
const DEFAULT_MAX_SAMPLES = 4000;
const NAME = 'check_motion_clearance';

const FIXES: Readonly<Record<string, string>> = {
  FPR_NO_MOTION: 'Add rigid bodies and joints (add_rigid_body, add_body_joint) and a drive (add_motor), then retry; see inspect_dynamics.',
  FPR_UNKNOWN_ID: 'Use ids from the document (list_entities) and a revolute joint id from inspect_dynamics for crankAxis.',
  FPR_BUDGET_EXCEEDED: 'Narrow the request with ids, use pairs "moving", or lower maxSamples / duration.',
};

const clearanceParams = z.object({
  ids: z
    .array(z.string())
    .min(1)
    .optional()
    .describe('Focus parts (entity / instance ids): only pairs where at least one part is in this list are checked. Default: every pair.'),
  crankAxis: z
    .string()
    .optional()
    .describe(
      'Id of a revolute joint of the mechanism (e.g. the crank joint) whose angle (deg, 0-360) labels the findings; default none (time only).',
    ),
  duration: z
    .number()
    .positive()
    .max(600)
    .optional()
    .describe(`Simulated seconds. Default ${DEFAULT_DURATION}. Cover at least one full cycle.`),
  timestep: z.number().min(1e-5).max(0.01).optional().describe('Integration step in seconds; default as simulate_motion.'),
  sampleRate: z
    .number()
    .positive()
    .optional()
    .describe('Recorded samples per second; default as simulate_motion (36 per crank turn). Higher = finer contact intervals.'),
  clearanceMm: z
    .number()
    .min(0)
    .optional()
    .describe('Required clearance in millimetres: pairs closer than this at any moment give FPR_MOTION_CLEARANCE_LOW. Default 0 (off).'),
  touchToleranceMm: z
    .number()
    .positive()
    .optional()
    .describe(`Distance in millimetres at or below which surfaces count as in contact. Default ${DEFAULT_TOUCH_MM}.`),
  pairs: z
    .enum(['moving', 'all'])
    .optional()
    .describe('"moving" (default): only pairs with at least one moving part. "all": also pairs of parts that never move.'),
  maxSamples: z
    .number()
    .int()
    .min(2)
    .max(6001)
    .optional()
    .describe(`Most samples evaluated; a longer run is thinned evenly. Default ${DEFAULT_MAX_SAMPLES}.`),
});

/**
 * @affects nothing — read-only; returns the CheckResult envelope (check 'motion_clearance') + pairs[], samples, minClearance in data
 * @invariant returns the SAME document, affected []; deterministic; touch (zero overlap volume, e.g. a pin in its bore) is never a failure;
 *   a declared allow_interference intent turns an interference into FPR_MOTION_ALLOWED (pass)
 * @failure no kernel -> rejected by execute; no rigid bodies / nothing moves / simulation refused -> FPR_NO_MOTION (or the simulation's own
 *   code, e.g. FPR_LOOP_OPEN); unknown ids or crankAxis not a revolute joint -> FPR_UNKNOWN_ID; over a budget -> FPR_BUDGET_EXCEEDED
 */
export const checkMotionClearance = defineCommand({
  name: NAME,
  annotations: { readOnly: true, requiresKernel: true },
  description:
    'Does the mechanism hit anything while it moves, and how close does it come? Runs the physics simulation (same engine and parameters ' +
    'as simulate_motion), carries every 3D part with its rigid body through the simulated poses and measures, for every pair with at least ' +
    'one moving part, the minimum surface distance at each sample (poses are interpolated between samples so a thin obstacle is not ' +
    'skipped). Reports per pair data.pairs[]: minClearanceMm with the time (s) and crank angle (deg, when crankAxis is given) where it ' +
    'occurs and witness points, plus every collision interval (start / end time and crank angle, overlap volume mm3 and a penetration ' +
    'estimate at the worst pose). Items: FPR_MOTION_INTERFERENCE (fail; parts overlap with volume), FPR_MOTION_CLEARANCE_LOW (warn; closer ' +
    'than clearanceMm), FPR_MOTION_TOUCH (info; contact without volume, e.g. a pin in its bore), FPR_MOTION_ALLOWED (pass; overlap declared ' +
    'with allow_interference), FPR_MOTION_UNDERSAMPLED (warn; a pass may miss a short contact). status is the worst item; not_run is never ' +
    'a pass. data.minClearance is the closest approach among pairs that never overlap or touch. Parts of one rigid body are never compared with each other. Collision intervals are resolved to the sample spacing ' +
    '(data.samples.resolutionS). Limits: a part wholly inside another without surface contact is not detected; kinematic sweeps ' +
    '(motion_study) are not supported, only simulated runs. Read-only. Next: fix interferences or declare them; then check_prototype. ' +
    'Computed by llull, not approved: a qualified engineer must review.',
  params: clearanceParams,
  run: (doc, params, ctx): CommandResult => motionClearanceCheck(doc, params, ctx, null),
});

/** The check on `shared` (a simulate_motion result with poses, from check_prototype) or, when null, on its own run. */
export function motionClearanceCheck(
  doc: CadDocument,
  params: z.infer<typeof clearanceParams>,
  ctx: ExecutionContext | undefined,
  shared: CommandResult | null,
): CommandResult {
  const context = ctx ?? currentContext();
  const kernel = context.kernel;
  if (kernel === null) return noop(doc, `${NAME}: no geometry kernel is installed; no-op.`);
  const refuse = (code: keyof typeof FIXES, message: string, ids: readonly string[] = []): CommandResult =>
    codedRejection(doc, NAME, code, message, FIXES[code] ?? '', ids);
  const dynamics = dynamicsOf(doc);
  if (Object.keys(dynamics.bodies).length === 0) return refuse('FPR_NO_MOTION', 'the document has no rigid bodies, so nothing moves');
  const unknown = (params.ids ?? []).filter((id) => doc.entities[id] === undefined);
  if (unknown.length > 0) return refuse('FPR_UNKNOWN_ID', `unknown entity id(s) ${unknown.join(', ')}`, unknown);
  const { crankAxis } = params;
  if (crankAxis !== undefined && dynamics.joints[crankAxis]?.kind !== 'revolute')
    return refuse('FPR_UNKNOWN_ID', `crankAxis '${crankAxis}' is not a revolute joint of the mechanism`, [crankAxis]);

  const run =
    shared ??
    simulateMotion.run(
      doc,
      {
        duration: params.duration ?? DEFAULT_DURATION,
        detail: 'poses',
        ...(params.timestep !== undefined ? { timestep: params.timestep } : {}),
        ...(params.sampleRate !== undefined ? { sampleRate: params.sampleRate } : {}),
      },
      ctx,
    );
  const sim = run.data as SimulationData | undefined;
  if (sim === undefined || sim.poses === undefined) {
    const why = run.summary.replace(/^simulate_motion:\s*/, '');
    return run.rejected && run.error !== undefined
      ? rejection(doc, `${NAME}: ${why}`, run.error)
      : refuse('FPR_NO_MOTION', `the simulation did not run — ${why.replace(/;\s*no-op\.$/, '')}`);
  }
  const { poses } = sim;
  if (!Object.values(poses.bodies).some(isMoving))
    return refuse('FPR_NO_MOTION', 'no rigid body moved during the simulation (add a motor or an initial speed, or lengthen duration)');
  const angleSeries = crankAxis === undefined ? undefined : sim.series?.jointPosition[crankAxis];
  if (crankAxis !== undefined && angleSeries === undefined)
    return refuse('FPR_UNKNOWN_ID', `crankAxis '${crankAxis}' closes a loop; name a joint of the kinematic tree`, [crankAxis]);

  const { ids: partIds } = candidateIds(doc);
  if (partIds.length > MAX_PARTS) return refuse('FPR_BUDGET_EXCEEDED', `${partIds.length} parts, limit ${MAX_PARTS}`);
  const collected = collectParts(doc, kernel, new Set(partIds));
  const built = collected.parts.filter((part) => part.mesh !== null && part.mesh.indices.length > 0);
  const links = assemblyLinks(doc, new Set(partIds));
  const mmPerUnit = MM_PER_UNIT[doc.units];
  const stride = Math.ceil(poses.times.length / (params.maxSamples ?? DEFAULT_MAX_SAMPLES));
  const plan = planMotion({
    doc,
    kernel,
    parts: built,
    bodyOf: links.bodyOf,
    poses,
    crankDeg: angleSeries === undefined ? null : angleSeries.map((rad) => (rad * 180) / Math.PI),
    focus: params.ids === undefined ? null : new Set(params.ids),
    includeStatic: params.pairs === 'all',
    stride,
    eps: (params.touchToleranceMm ?? DEFAULT_TOUCH_MM) / mmPerUnit,
    clearance: (params.clearanceMm ?? 0) / mmPerUnit,
    mmPerUnit,
  });
  if (plan.pairs.length > MAX_PAIRS) return refuse('FPR_BUDGET_EXCEEDED', `${plan.pairs.length} candidate pairs, limit ${MAX_PAIRS}`);
  if (plan.pairs.length * plan.times.length > MAX_PAIR_SAMPLES)
    return refuse(
      'FPR_BUDGET_EXCEEDED',
      `${plan.pairs.length} pairs x ${plan.times.length} samples is over ${MAX_PAIR_SAMPLES} pair-samples`,
    );

  const outcome = runMotion(plan, { evaluations: MAX_EVALUATIONS, classified: MAX_CLASSIFIED_TOTAL });
  if (outcome.exhausted)
    return refuse('FPR_BUDGET_EXCEEDED', `the sweep needs more than ${MAX_EVALUATIONS} distance evaluations (fast motion, many pairs)`);
  const items: CheckItem[] = [
    ...collected.refused.map(
      ({ id }): CheckItem => ({
        code: 'FPR_PART_INVALID',
        status: 'not_run',
        ids: [id],
        findingKey: `motion_clearance:FPR_PART_INVALID:${id}`,
        values: {},
        remediation: 'The kernel could not build this part, so it was not checked: fix it (check_assembly says why).',
        unverified: true,
      }),
    ),
    ...outcome.items,
  ];
  if (plan.pairs.length === 0)
    items.push({
      code: 'FPR_NO_PAIRS',
      status: 'not_run',
      ids: [],
      findingKey: 'motion_clearance:FPR_NO_PAIRS:',
      values: {},
      remediation: 'No pair of parts has a moving member: give the moving parts to rigid bodies, or use pairs "all" / other ids.',
      unverified: true,
    });
  const closest = outcome.pairs.reduce<(typeof outcome.pairs)[number] | null>(
    (top, pair) =>
      pair.minClearanceMm !== null &&
      (pair.status === 'clear' || pair.status === 'clearance_low') &&
      (top === null || pair.minClearanceMm < (top.minClearanceMm ?? Infinity))
        ? pair
        : top,
    null,
  );
  const resolutionS = plan.times.reduce((widest, time, i) => Math.max(widest, i === 0 ? 0 : time - (plan.times[i - 1] ?? time)), 0);
  const result: CheckResult = {
    check: 'motion_clearance',
    status: items.length === 0 ? 'pass' : worstStatus(items.map((entry) => entry.status)),
    items,
    provenance: {
      method: 'simulated poses + mesh BVH minimum distance; interpolated substeps; overlap volume through the kernel at contact intervals',
      ...(kernel.name === undefined ? {} : { kernel: kernel.name }),
      engine: sim.engine,
      tolerances: { epsTouchMm: params.touchToleranceMm ?? DEFAULT_TOUCH_MM, clearanceMm: params.clearanceMm ?? 0, resolutionS },
      params: { ...params },
    },
    inputsHash: hashText(
      canonicalJson({
        parts: built.map((part) => [part.id, recipeKey(part.recipe)]),
        dynamics: doc.dynamics ?? null,
        prototype: checkedPrototype(doc.prototype) ?? null,
        params,
        units: doc.units,
        kernel: kernel.name ?? null,
        engine: sim.engine,
      }),
    ),
    unverified: items.some((entry) => entry.status === 'not_run' || entry.unverified === true),
    reviewRequired: true,
  };
  const data = {
    ...result,
    pairs: outcome.pairs,
    minClearance:
      closest === null
        ? null
        : { mm: closest.minClearanceMm, a: closest.a, b: closest.b, timeS: closest.timeS, crankDeg: closest.crankDeg },
    samples: {
      simulated: sim.samples,
      evaluated: plan.times.length,
      stride,
      resolutionS,
      durationS: sim.duration,
      evaluations: outcome.evaluations,
    },
  };
  const count = (status: string): number => items.filter((entry) => entry.status === status).length;
  const gap =
    closest === null
      ? 'no pair evaluated'
      : `closest ${closest.a} / ${closest.b} ${(closest.minClearanceMm ?? 0).toPrecision(4)} mm at t = ${(closest.timeS ?? 0).toPrecision(4)} s` +
        (closest.crankDeg === null ? '' : ` (${closest.crankDeg.toPrecision(4)} deg)`);
  const summary =
    `${NAME}: ${result.status} — ${outcome.pairs.length} pair(s) over ${plan.times.length} samples, ${count('fail')} interference/fail, ` +
    `${count('warn')} warn, ${count('not_run')} not_run; ${gap}. ` +
    (result.status === 'fail' ? 'Next: see data.pairs[].collisions for when it hits.' : 'Next: check_prototype.') +
    ' Computed by llull, not approved — needs a qualified engineer.';
  return report(doc, summary, roundDeep(data));
}
