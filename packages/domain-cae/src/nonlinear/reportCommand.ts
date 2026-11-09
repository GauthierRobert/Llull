/** nonlinear_report: the solved results of a nonlinear_static case as data (PHY-05 FR-NLS-06, TR §5.5). */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact, NonlinearSettings, ResultsSummary } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import { analysisLengthMetres } from '../shared/defaults';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { lengthUnitName } from '../decks/units';
import { caseOf } from '../shared/access';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord } from '../shared/trust';
import { NOT_APPROVED } from '../contact/codes';
import { refuseNls } from './codes';
import { snapBackDetected } from './curveRules';
import { extractCurves, type CurveData } from './curves';
import { loadUnitOf, probeOf, unverifiedReasons } from './limitLoadQuery';
import { permanentSetOf, permanentSetVerdict } from './permanentSet';

const NAME = 'nonlinear_report';
/** Samples of a curve in the default `summary` view (first and last kept) and the page size of `increments: all` (AF-12). */
const SUMMARY_POINTS = 100;
const PAGE_POINTS = 1000;

const sig = (value: number): string => significantNumber(value, 6);

/** `count` indices of `length` samples, evenly spread, first and last included. */
function spread(length: number, count: number): number[] {
  if (length <= count) return Array.from({ length }, (_, index) => index);
  return Array.from({ length: count }, (_, index) => Math.round((index * (length - 1)) / (count - 1)));
}

const named = (
  value: number | string,
  source: string,
  defaulted: boolean,
): { value: number | string; source: string; defaulted: boolean } => ({ value, source, defaulted });

/** Controls with named values (AF-31): every increment value comes from the plan, the convergence preset from the manual or the plan. */
function controlsOf(nonlinear: NonlinearSettings): Record<string, unknown> {
  const ccx = nonlinear.convergence.name === 'ccx_default';
  return {
    convergence: {
      name: nonlinear.convergence.name,
      source: ccx ? 'CalculiX manual, Convergence criteria' : 'plan',
      defaulted: ccx,
      ...(nonlinear.convergence.field === undefined ? {} : { field: nonlinear.convergence.field }),
      ...(nonlinear.convergence.timeIncrementation === undefined ? {} : { timeIncrementation: nonlinear.convergence.timeIncrementation }),
    },
    outputIncrements: nonlinear.outputIncrements,
    steps: nonlinear.stepOrder.flatMap((stepId) => {
      const step = nonlinear.steps[stepId];
      if (step === undefined) return [];
      const control = step.control;
      return [
        {
          stepId,
          name: step.name,
          control: control.kind,
          amplitude: step.amplitude,
          multipliers: step.multipliers,
          ...(control.kind === 'arc_length'
            ? {}
            : {
                initialIncrement: named(control.initialIncrement, 'plan', false),
                minIncrement: named(control.minIncrement, 'plan', false),
                maxIncrement: named(control.maxIncrement, 'plan', false),
                maxIncrements: named(control.maxIncrements, 'plan', false),
              }),
        },
      ];
    }),
  };
}

/** permanentSet of the data: the residual state with the stated limits and whether each is exceeded (null = no limit stated or nothing to compare). */
function permanentSetRecord(
  doc: CadDocument,
  analysis: AnalysisCase,
  nonlinear: NonlinearSettings,
  results: FeResultsArtifact,
  mesh: FeMeshArtifact | null,
): Record<string, unknown> | null {
  if (mesh === null) return null;
  const set = permanentSetOf(nonlinear, mesh, results);
  if (set === null) return null;
  const lengthToAnalysis = toMetres(doc, 1) / analysisLengthMetres(analysis.unitSystem);
  return { ...set, ...permanentSetVerdict(set, nonlinear.thresholds, lengthToAnalysis) };
}

function curveRecord(
  analysis: AnalysisCase,
  nonlinear: NonlinearSettings,
  curve: CurveData,
  summary: NonNullable<ResultsSummary['nonlinear']>['curves'][number],
  view: { readonly all: boolean; readonly from: number },
): { readonly record: Record<string, unknown>; readonly more: boolean } {
  const probe = nonlinear.probes[curve.probeId];
  const indices = view.all
    ? Array.from({ length: Math.max(0, Math.min(PAGE_POINTS, curve.time.length - view.from)) }, (_, index) => view.from + index)
    : spread(curve.time.length, SUMMARY_POINTS);
  const pick = (values: readonly number[]): number[] => indices.map((index) => values[index] ?? 0);
  const next = view.from + PAGE_POINTS;
  return {
    record: {
      probeId: curve.probeId,
      name: curve.name,
      loadUnit: probe === undefined ? '' : loadUnitOf(analysis, probe),
      displacementUnit: lengthUnitName(analysis.unitSystem),
      points: curve.time.length,
      maxLoad: Math.abs(summary.peakLoad),
      displacementRange: summary.dispRange,
      snapBack: snapBackDetected(nonlinear, curve),
      curveHash: summary.curveHash,
      sampled: !view.all && curve.time.length > SUMMARY_POINTS,
      ...(view.all ? { from: view.from, to: view.from + indices.length } : {}),
      time: pick(curve.time),
      load: pick(curve.load),
      displacement: pick(curve.displacement),
    },
    more: view.all && next < curve.time.length,
  };
}

/**
 * @affects nothing (read-only query; data = controls, steps, curves, max PEEQ, permanent set, provenance)
 * @invariant every number is recomputed from the results artifact re-verified by trustedRecord; reviewRequired always true; unverified = OR of the
 *   material flags (AF-32); curves are paged beyond 1000 points with increments all + cursor (AF-12); summary view keeps at most 100 samples
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not nonlinear_static -> NLS_CASE_NOT_NONLINEAR; unknown probe -> NLS_PROBE_REFERENCE_UNKNOWN;
 *   stale results -> NLS_CURVE_STALE; untrusted -> FEA_SUMMARY_MISMATCH; no verified results -> FEA_RESULTS_MISSING; cursor with summary view -> NLS_CONTROL_INVALID
 */
export const nonlinearReport = defineCommand({
  name: NAME,
  description:
    'Read the RESULTS of a SOLVED nonlinear_static analysis as data (describe_analysis reads the set-up). Returns data { state, completed, nlgeom, ' +
    'unitSystem, controls (convergence preset, outputIncrements, per step the increments as { value, source, defaulted }), steps [{ stepId, ' +
    'increments, cutbacks, iterations, lastLoadFactor, completed }], curves [{ probeId, name, loadUnit, displacementUnit, points, maxLoad, ' +
    'displacementRange, snapBack, curveHash, time[], load[], displacement[] }], maxPeeq { value, at, step } (equivalent plastic strain), permanentSet ' +
    '(after a step that returns every load to zero), provenance, unverified, reviewRequired }. increments "summary" (default) gives at most 100 ' +
    'samples per curve (first and last kept); "all" pages the curve points 1000 at a time: pass the returned nextCursor as cursor for the next page. ' +
    'probe limits the curves to one probe (id or unique name). Refuses stale results (NLS_CURVE_STALE: run fea_mesh and fea_solve again). Always ' +
    'reviewRequired: computed by llull, not approved. Next: limit_load for the collapse load, check_nonlinear.',
  annotations: { readOnly: true },
  params: z.object({
    analysisId: analysisIdSchema,
    probe: z
      .string()
      .optional()
      .describe('Only this curve probe: its id (affected[0] of add_curve_probe) or its unique name. Default: every probe.'),
    increments: z
      .enum(['summary', 'all'])
      .optional()
      .describe(
        '"summary" (default): at most 100 evenly spread samples per curve; "all": every stored increment, 1000 per page (see cursor).',
      ),
    cursor: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('increments "all" only: index of the first point of the page (default 0); use the nextCursor of the previous page.'),
  }),
  run: (doc, { analysisId, probe, increments = 'summary', cursor }, ctx): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseNls(doc, NAME, code, message, [analysisId], paths);
    const analysis = caseOf(doc, analysisId);
    if (analysis === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, ['analysisId']);
    const nonlinear = analysis.nonlinear;
    if (analysis.type !== 'nonlinear_static' || nonlinear === undefined)
      return fail('NLS_CASE_NOT_NONLINEAR', `analysis '${analysisId}' is ${analysis.type}: nonlinear_report reads nonlinear_static cases`, [
        'analysisId',
      ]);
    if (cursor !== undefined && increments !== 'all')
      return fail('NLS_CONTROL_INVALID', 'cursor applies to increments "all" only', ['cursor']);
    const wanted = probe === undefined ? undefined : probeOf(analysis, probe);
    if (probe !== undefined && wanted === undefined)
      return fail(
        'NLS_PROBE_REFERENCE_UNKNOWN',
        `no curve probe '${probe}' in '${analysisId}' (probes: ${nonlinear.probeOrder.join(', ') || 'none'})`,
        ['probe'],
      );
    const trust = trustedRecord(doc, analysis, ctx?.feaArtifacts);
    if (trust.state === 'stale')
      return fail('NLS_CURVE_STALE', `the results of '${analysisId}' predate a change of its inputs: fea_mesh + fea_solve again`);
    if (trust.state === 'untrusted')
      return fail(trust.problem?.code ?? 'FEA_SUMMARY_MISMATCH', trust.problem?.message ?? 'untrusted results');
    const results = trust.resultsArtifact;
    const summary = trust.results;
    if (results === null || summary === null || summary.nonlinear === undefined)
      return fail(
        'FEA_RESULTS_MISSING',
        `analysis '${analysisId}' has no verified nonlinear results (${trust.problem?.message ?? `state ${trust.state}`})`,
      );
    const view = { all: increments === 'all', from: cursor ?? 0 };
    const curves = extractCurves(analysis, results)
      .filter((curve) => wanted === undefined || curve.probeId === wanted.id)
      .flatMap((curve) => {
        const entry = summary.nonlinear?.curves.find((candidate) => candidate.probeId === curve.probeId);
        return entry === undefined ? [] : [curveRecord(analysis, nonlinear, curve, entry, view)];
      });
    const reasons = unverifiedReasons(doc, analysis);
    const solved = summary.nonlinear;
    const increment = solved.steps.reduce((sum, step) => sum + step.increments, 0);
    const peak = curves.reduce((best, entry) => Math.max(best, Math.abs(Number(entry.record['maxLoad']))), 0);
    const nextCursor = curves.some((entry) => entry.more) ? view.from + PAGE_POINTS : null;
    return report(
      doc,
      `${NAME}: '${analysisId}' ${solved.completed ? 'all steps completed' : 'NOT all steps completed'} (${solved.steps.length} step(s), ${increment} increment(s)), nlgeom ${solved.nlgeom}; ${curves.length} curve(s)${curves.length > 0 ? `, max load ${sig(peak)}` : ''}${solved.maxPeeq === undefined ? '' : `, max PEEQ ${sig(solved.maxPeeq.value)}`}${reasons.length > 0 ? '; UNVERIFIED inputs' : ''}${nextCursor === null ? '' : `; more points: cursor ${nextCursor}`}. ${NOT_APPROVED}`,
      {
        analysisId,
        state: trust.state,
        completed: solved.completed,
        nlgeom: solved.nlgeom,
        unitSystem: analysis.unitSystem,
        controls: controlsOf(nonlinear),
        steps: solved.steps,
        curves: curves.map((entry) => entry.record),
        nextCursor,
        maxPeeq: solved.maxPeeq ?? null,
        permanentSet: permanentSetRecord(doc, analysis, nonlinear, results, trust.meshArtifact),
        thresholds: nonlinear.thresholds ?? null,
        loadCases: summary.loadCases,
        provenance: {
          solver: results.solver,
          solverVersion: results.solverVersion ?? null,
          inputHash: analysis.results?.inputHash ?? null,
          resultsHash: analysis.results?.resultsHash ?? null,
          limitPointRule:
            'a load-controlled run that stops at a limit point is a solver failure and is never recorded (use displacement control)',
          notRead: ['plasticVolumeFraction'],
        },
        unverified: reasons.length > 0,
        unverifiedReasons: reasons,
        reviewRequired: true,
        reviewReason: 'nonlinear result may support a strength or permanent-set claim',
      },
    );
  },
});
