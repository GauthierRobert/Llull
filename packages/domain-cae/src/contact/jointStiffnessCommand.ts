/** joint_stiffness_from_fe: the joint stiffness factor n*phi of a preloaded bolt from a solved nonlinear_static case (PHY-06 FR-CNT-07, VDI 2230 / NASA-STD-5020 definitions). */

import type { AnalysisCase, CurveProbe } from '@core/model/analysis';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord } from '../shared/trust';
import { extractCurves } from '../nonlinear/curves';
import { isRefusal, nonlinearCase } from '../nonlinear/settings';
import { forceUnitName, findBolt } from './pretensionRules';
import { boltReport } from './boltReport';
import { NOT_APPROVED, refuseCnt } from './codes';

const n = (value: number): string => significantNumber(value, 5);

interface Point {
  readonly time: number;
  readonly load: number;
  readonly force: number;
}

/** Probe of `analysis` by id or unique name. */
function probeOf(analysis: AnalysisCase, reference: string): CurveProbe | undefined {
  const probes = analysis.nonlinear?.probes ?? {};
  if (Object.hasOwn(probes, reference)) return probes[reference];
  const named = Object.values(probes).filter((probe) => probe.name === reference);
  return named.length === 1 ? named[0] : undefined;
}

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
    const found = nonlinearCase(doc, command, params.analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseCnt(doc, command, code, message, [analysis.id], [path]);
    const bolt = findBolt(analysis.pretension, params.pretension);
    if (bolt === undefined)
      return fail('CNT_PRETENSION_NOT_FOUND', `no bolt pretension '${params.pretension}' in '${analysis.id}'`, 'pretension');
    const probe = probeOf(analysis, params.loadProbe);
    if (probe === undefined)
      return fail('CNT_INPUT_INVALID', `no curve probe '${params.loadProbe}' in '${analysis.id}' (add_curve_probe)`, 'loadProbe');
    const steps = analysis.nonlinear?.steps ?? {};
    const stepId = Object.hasOwn(steps, params.stepId)
      ? params.stepId
      : Object.values(steps).find((step) => step.name === params.stepId)?.id;
    if (stepId === undefined) return fail('NLS_STEP_NOT_FOUND', `no step '${params.stepId}'`, 'stepId');
    if (stepId === bolt.preloadStepId)
      return fail(
        'CNT_INPUT_INVALID',
        `step '${stepId}' is the preload step of '${bolt.id}': the bolt force there is the tightening, not the response to a load`,
        'stepId',
      );
    if (probe.load.kind === 'load') {
      const loadId = probe.load.loadId;
      const load = Object.hasOwn(analysis.loads, loadId) ? analysis.loads[loadId] : undefined;
      if (load?.kind !== 'force')
        return fail(
          'CNT_INPUT_INVALID',
          `probe '${probe.name}' plots a ${load?.kind ?? 'missing'} load, not a force: use a force load or a reaction probe`,
          'loadProbe',
        );
    }
    const trust = trustedRecord(doc, analysis, ctx?.feaArtifacts);
    if (trust.state !== 'solved' || trust.resultsArtifact === null || trust.meshArtifact === null)
      return fail(
        trust.state === 'stale' ? 'FEA_RESULTS_STALE' : trust.state === 'untrusted' ? 'FEA_SUMMARY_MISMATCH' : 'FEA_RESULTS_MISSING',
        trust.problem?.message ?? `no current verified results (state ${trust.state}): run fea_mesh and fea_solve`,
        'analysisId',
      );
    const bolts = boltReport(doc, analysis, trust.meshArtifact, trust.resultsArtifact, 'all');
    if ('code' in bolts) return refuseCnt(doc, command, bolts.code, bolts.message, bolts.ids, ['analysisId']);
    const curve = extractCurves(analysis, trust.resultsArtifact).find((entry) => entry.probeId === probe.id);
    if (curve === undefined) return fail('CNT_INPUT_INVALID', `probe '${probe.name}' has no curve in the results`, 'loadProbe');
    const sign = probe.load.kind === 'reaction' ? -1 : 1;
    const loadAt = new Map(curve.time.map((time, index) => [time, sign * (curve.load[index] ?? 0)]));
    const rows = bolts.bolts.filter((row) => row.pretensionId === bolt.id).sort((a, b) => a.time - b.time);
    const order = analysis.nonlinear?.stepOrder ?? [];
    const previous = order[order.indexOf(stepId) - 1];
    const inStep = rows.filter((row) => row.stepId === stepId);
    if (inStep.length === 0)
      return fail(
        'CNT_INPUT_INVALID',
        `step '${stepId}' has no stored increment with a bolt force: set_nonlinear_controls outputIncrements all`,
        'stepId',
      );
    const start = rows.filter((row) => row.stepId === previous).at(-1);
    const candidates = start === undefined ? inStep : [start, ...inStep];
    const withLoad = candidates.flatMap((row) => {
      const load = loadAt.get(row.time);
      return load === undefined ? [] : [{ time: row.time, load, force: row.axialForce }];
    });
    const separatedAt = bolts.separated
      .filter((entry) => entry.pretensionId === bolt.id)
      .reduce<number | null>((first, entry) => (first === null ? entry.time : Math.min(first, entry.time)), null);
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
          startsFromPreviousStep: start !== undefined && used[0]?.time === start.time,
        },
        separatedAt,
        droppedIncrements: candidates.length - withLoad.length,
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
