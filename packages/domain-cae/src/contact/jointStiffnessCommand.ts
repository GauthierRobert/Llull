/** joint_stiffness_from_fe: the joint stiffness factor n*phi of a preloaded bolt from a solved nonlinear_static case (PHY-06 FR-CNT-07, VDI 2230 / NASA-STD-5020 definitions). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { analysisIdSchema } from '../shared/schemas';
import { forceUnitName } from './pretensionRules';
import { isSeries, jointSeriesOf, type Point } from './jointSeries';
import { NOT_APPROVED, refuseCnt } from './codes';

const n = (value: number): string => significantNumber(value, 5);

/**
 * Least-squares line of the bolt force against the applied load.
 * @invariant slope = sum((L - mean L)(N - mean N)) / sum((L - mean L)^2); r2 = 1 when the force does not change
 */
function fitLine(points: readonly Point[]): { slope: number; intercept: number; r2: number; secant: number } {
  const count = points.length;
  const meanL = points.reduce((sum, p) => sum + p.load, 0) / count;
  const meanN = points.reduce((sum, p) => sum + p.force, 0) / count;
  const sLL = points.reduce((sum, p) => sum + (p.load - meanL) ** 2, 0);
  const sNN = points.reduce((sum, p) => sum + (p.force - meanN) ** 2, 0);
  const sLN = points.reduce((sum, p) => sum + (p.load - meanL) * (p.force - meanN), 0);
  const slope = sLN / sLL;
  const first = points[0];
  const last = points[count - 1];
  return {
    slope,
    intercept: meanN - slope * meanL,
    r2: sNN === 0 ? 1 : (sLN * sLN) / (sLL * sNN),
    secant: first === undefined || last === undefined ? Number.NaN : (last.force - first.force) / (last.load - first.load),
  };
}

/**
 * @invariant read-only; forces from the stress on the cut faces (contact_report bolts), loads from a curve probe of the same results (re-verified against
 *   the artifact store); only increments before the first separation of the bolt's clamp zone count; reviewRequired
 * @failure unknown / non-nonlinear case -> FEA_ANALYSIS_NOT_FOUND / NLS_CASE_NOT_NONLINEAR; unknown bolt -> CNT_PRETENSION_NOT_FOUND; unknown probe, preload
 *   step, step without increments, a probe in stress units, fewer than 2 usable increments or no load change -> CNT_INPUT_INVALID; separated before 2 usable
 *   increments -> CNT_SEPARATED; stale / no results -> FEA_RESULTS_STALE / FEA_RESULTS_MISSING / FEA_SUMMARY_MISMATCH
 */
export const jointStiffnessFromFe = defineCommand({
  name: 'joint_stiffness_from_fe',
  description:
    'Joint stiffness factor n*phi of a preloaded bolt from a SOLVED nonlinear_static analysis: the slope of the bolt axial force (contact_report bolts: stress on ' +
    'the cut faces) against the applied external load (a curve probe, add_curve_probe) over the increments of one step AFTER the preload step, ' +
    'least-squares over the increments before the clamp zone separates (the first fully open increment ends the range; CNT_SEPARATED when fewer than 2 ' +
    'remain). loadProbe = the probe id / name; its load must be a FORCE: a reaction probe is taken with the sign flipped (the reaction opposes the ' +
    'applied load), a load probe must be a force load. The step starts from the last increment of the previous step. Needs several stored increments in ' +
    'the step (set_nonlinear_controls outputIncrements all). Returns data { nPhi, secant, r2, intercept, range { points, fromTime, toTime, load, boltForce }, ' +
    'separatedAt, droppedIncrements, phi (when loadingPlaneFactor n is given) }; feed nPhi into bolted_joint_check. A reviewer compares it with the ' +
    `joint_from_fastener_stack Shigley estimate. ${NOT_APPROVED}`,
  annotations: { readOnly: true },
  params: z.object({
    analysisId: analysisIdSchema,
    pretension: z.string().describe('Bolt id (affected[1] of add_bolt_pretension) or unique name.'),
    loadProbe: z.string().describe('Curve probe (id or unique name) whose load axis is the applied external force through the joint.'),
    stepId: z.string().describe('Step (id or unique name) AFTER the preload step in which the external load grows.'),
    loadingPlaneFactor: z
      .number()
      .optional()
      .describe(
        'Loading-plane factor n in (0, 1] (NASA-STD-5020 6.1.e, from the design); when given the result also reports phi = nPhi / n.',
      ),
  }),
  run: (doc, params, ctx?: ExecutionContext): CommandResult => {
    const command = 'joint_stiffness_from_fe';
    const series = jointSeriesOf(doc, command, params, ctx);
    if (!isSeries(series)) return series;
    const { analysis, bolt, probe, stepId, sign, separatedAt } = series;
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseCnt(doc, command, code, message, [analysis.id], [path]);
    const withLoad = series.points;
    const used: Point[] = withLoad.filter((point) => separatedAt === null || point.time < separatedAt);
    const first = used[0];
    const last = used[used.length - 1];
    if (used.length < 2 || first === undefined || last === undefined)
      return separatedAt === null
        ? fail(
            'CNT_INPUT_INVALID',
            `fewer than 2 increments of step '${stepId}' carry both a bolt force and a probe load (${withLoad.length} do): store every increment`,
            'stepId',
          )
        : fail(
            'CNT_SEPARATED',
            `the clamp zone of '${bolt.id}' is open from time ${n(separatedAt)}: fewer than 2 unseparated increments remain in step '${stepId}'`,
            'stepId',
          );
    if (!(Math.abs(last.load - first.load) > 0))
      return fail('CNT_INPUT_INVALID', `the applied load does not change over the usable increments of step '${stepId}'`, 'loadProbe');
    const fit = fitLine(used);
    const force = forceUnitName(analysis.unitSystem);
    const factor = params.loadingPlaneFactor;
    const phi = factor !== undefined && factor > 0 && factor <= 1 ? fit.slope / factor : null;
    const warnings = [
      ...(fit.slope < -0.05 || fit.slope > 1.05
        ? [`nPhi ${n(fit.slope)} is outside [0, 1]: check that the probe is the external force through the joint and its direction`]
        : []),
      ...(fit.r2 < 0.99
        ? [`the force-load relation is not linear over the range (r2 ${n(fit.r2)}): narrow the step or look at the increments`]
        : []),
      ...(factor !== undefined && phi === null ? ['loadingPlaneFactor must be in (0, 1]: phi not reported'] : []),
    ];
    return report(
      doc,
      `${command}: bolt '${bolt.id}' in '${analysis.id}', step '${stepId}', probe '${probe.name}': nPhi = ${n(fit.slope)} (secant ${n(fit.secant)}, r2 ${n(fit.r2)}) over ${used.length} unseparated increment(s), load ${n(first.load)} .. ${n(last.load)} ${force}, bolt force ${n(first.force)} .. ${n(last.force)} ${force}${separatedAt === null ? '' : `; the clamp zone separates at time ${n(separatedAt)} (later increments excluded)`}${phi === null ? '' : `; phi ${n(phi)} for n ${factor}`}. ${NOT_APPROVED}`,
      {
        analysisId: analysis.id,
        pretensionId: bolt.id,
        stepId,
        probe: { id: probe.id, name: probe.name, load: probe.load.kind, sign },
        nPhi: fit.slope,
        secant: fit.secant,
        r2: fit.r2,
        intercept: fit.intercept,
        phi,
        range: {
          points: used.length,
          fromTime: first.time,
          toTime: last.time,
          load: [first.load, last.load],
          boltForce: [first.force, last.force],
          startsFromPreviousStep: series.startsFromPreviousStep,
        },
        separatedAt,
        droppedIncrements: series.droppedIncrements,
        unit: force,
        warnings,
        provenance: {
          definition:
            'nPhi = d(bolt axial force) / d(applied load): least-squares slope over the unseparated increments (NASA-STD-5020 6.1.e: n phi P)',
          boltForce: 'stress on the cut faces integrated (contact_report bolts)',
          load:
            probe.load.kind === 'reaction'
              ? 'minus the constraint reaction of the probe'
              : 'the force load of the probe times its step multiplier',
        },
        reviewRequired: true,
      },
    );
  },
});
