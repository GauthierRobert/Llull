/** The bolt force against the applied load over the increments of one step of a solved nonlinear_static case (shared by joint_stiffness_from_fe and joint_margins). */

import type { AnalysisCase, CurveProbe } from '@core/model/analysis';
import type { BoltPretension } from '@core/model/contact';
import type { CadDocument } from '@core/model/types';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { trustedRecord } from '../shared/trust';
import { extractCurves } from '../nonlinear/curves';
import { isRefusal, nonlinearCase } from '../nonlinear/settings';
import { findBolt } from './pretensionRules';
import { boltReport } from './boltReport';
import { refuseCnt } from './codes';

export interface Point {
  readonly time: number;
  readonly load: number;
  readonly force: number;
}

export interface JointSeries {
  readonly analysis: AnalysisCase;
  readonly bolt: BoltPretension;
  readonly probe: CurveProbe;
  readonly stepId: string;
  /** -1 for a reaction probe (the reaction opposes the applied load), 1 for a force load. */
  readonly sign: 1 | -1;
  /** Increments of the step (and the last one of the previous step) that have both a bolt force and a probe load, in time order. */
  readonly points: readonly Point[];
  readonly startsFromPreviousStep: boolean;
  /** False when the applied load falls between two consecutive increments (an unloading or a reversal): a slope or an interpolation over it is not one joint response. */
  readonly monotonic: boolean;
  /** Time of the first increment in which the clamp zone of the bolt is fully open; null when it never separates. */
  readonly separatedAt: number | null;
  readonly droppedIncrements: number;
}

/** Probe of `analysis` by id or unique name. */
function probeOf(analysis: AnalysisCase, reference: string): CurveProbe | undefined {
  const probes = analysis.nonlinear?.probes ?? {};
  if (Object.hasOwn(probes, reference)) return probes[reference];
  const named = Object.values(probes).filter((probe) => probe.name === reference);
  return named.length === 1 ? named[0] : undefined;
}

/**
 * The (load, bolt force) points of step `params.stepId` of a solved case.
 * @failure unknown / non-nonlinear case, bolt, probe, step; the preload step; a probe in stress units; no / stale results; no stored increment with both values -> the coded refusal of `command`
 */
export function jointSeriesOf(
  doc: CadDocument,
  command: string,
  params: { readonly analysisId: string; readonly pretension: string; readonly loadProbe: string; readonly stepId: string },
  ctx: ExecutionContext | undefined,
): JointSeries | CommandResult {
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
  const stepId = Object.hasOwn(steps, params.stepId) ? params.stepId : Object.values(steps).find((step) => step.name === params.stepId)?.id;
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

  return {
    analysis,
    bolt,
    probe,
    stepId,
    sign,
    points: withLoad,
    startsFromPreviousStep: start !== undefined,
    monotonic: withLoad.every((point, index) => {
      const before = withLoad[index - 1];
      return before === undefined || point.load >= before.load;
    }),
    separatedAt,
    droppedIncrements: candidates.length - withLoad.length,
  };
}

/** True for a series, false for the refusal result. */
export const isSeries = (value: JointSeries | CommandResult): value is JointSeries => 'points' in value;
