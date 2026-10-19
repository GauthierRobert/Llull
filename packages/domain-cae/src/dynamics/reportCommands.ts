/** dynamic_report (query) and equivalent_static_load_case (random rms -> 05 static gravity load): PHY-09 §4 results commands. */

import type { AnalysisCase, FeArtifactPort, FeaLoad } from '@core/model/analysis';
import type { DynamicSummary, EquivalentLoadProvenance } from '@core/model/structuralDynamics';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { nextId } from '@lib/id';
import { caseOf, withCase } from '../shared/access';
import { loadCaseNameProblem } from '../shared/names';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord } from '../shared/trust';
import { refuseDyn } from './codes';
import { peakFactorOf } from './math/gaussian';
import { dynamicCaseOf, libraryOf, withLibrary } from './store';
import { gravityInUnitSystem } from './units';

const n = (value: number): string => significantNumber(value, 6);

type Verified = {
  readonly analysisCase: AnalysisCase;
  readonly summary: DynamicSummary;
  readonly resultsHash: string;
  readonly state: string;
};

/** The verified dynamic summary of a solved, current case, or the refusal code (stale / missing / not dynamic). */
function verifiedSummary(
  doc: CadDocument,
  analysisId: string,
  port: FeArtifactPort | null | undefined,
): Verified | { code: string; message: string } {
  const found = dynamicCaseOf(doc, analysisId);
  if (found === 'missing') return { code: 'FEA_ANALYSIS_NOT_FOUND', message: `no analysis '${analysisId}'` };
  if (found === 'not_dynamic') return { code: 'DYN_CASE_TYPE', message: `analysis '${analysisId}' is not a dynamic case` };
  const trust = trustedRecord(doc, found.analysisCase, port);
  if (trust.state === 'stale') return { code: 'DYN_RESULTS_STALE', message: `the results of '${analysisId}' predate a set-up change` };
  const summary = trust.results?.dynamics;
  if (trust.state !== 'solved' || summary === undefined || trust.results === null)
    return { code: 'DYN_RESULTS_MISSING', message: `analysis '${analysisId}' has no verified results (state ${trust.state})` };
  return { analysisCase: found.analysisCase, summary, resultsHash: trust.results.resultsHash, state: trust.state };
}

/**
 * @invariant read-only; numbers come only from the summary re-verified against the artifacts (05 §4.1)
 * @failure unknown / non-dynamic -> FEA_ANALYSIS_NOT_FOUND / DYN_CASE_TYPE; stale -> DYN_RESULTS_STALE; unsolved / unverifiable -> DYN_RESULTS_MISSING
 */
export const dynamicReport = defineCommand({
  name: 'dynamic_report',
  description:
    'Read the results of a solved frequency_response / random_response case: data { summary: { modesKept, highestModeHz, massParticipation ' +
    '(cumulative effective-mass fraction x/y/z), dampingPerMode [{ mode, fHz, zeta }], probes (frf: peaks fHz / magnitude / phaseDeg / mode, ' +
    'qHalfPower; random: rms, peak = peakFactor x rms with the named 3-sigma default, zeroUpcrossingHz, spectrumGrms), nodalMax (random: per ' +
    'field component the largest nodal rms and where), frequencyPointsHz, unverified, unverifiedReasons, reviewRequired }, state }. Units: g ' +
    '(9.80665 m/s^2) for accelerations, the case length / stress unit otherwise. probes filters by probe name. Report it as "computed by llull, not approved".',
  annotations: { readOnly: true },
  params: z.object({ analysisId: analysisIdSchema, probes: z.array(z.string()).optional().describe('Probe names to keep; default all.') }),
  run: (doc, { analysisId, probes }, ctx): CommandResult => {
    const verified = verifiedSummary(doc, analysisId, ctx?.feaArtifacts);
    if ('code' in verified) return refuseDyn(doc, 'dynamic_report', verified.code, verified.message, [analysisId], ['analysisId']);
    const summary =
      probes === undefined
        ? verified.summary
        : { ...verified.summary, probes: verified.summary.probes.filter((probe) => probes.includes(probe.probe)) };
    const lines = summary.probes.map((probe) =>
      probe.kind === 'random'
        ? `${probe.probe} ${probe.quantity} ${n(probe.rms)} ${probe.unit} rms (3-sigma ${n(probe.peak)})`
        : `${probe.probe} ${probe.quantity} ${probe.peaks.length} peak(s)${probe.peaks[0] === undefined ? '' : `, first ${n(probe.peaks[0].magnitude)} ${probe.unit} at ${n(probe.peaks[0].fHz)} Hz`}`,
    );
    return report(
      doc,
      `dynamic_report: '${analysisId}' ${summary.type}, ${summary.modesKept} mode(s) to ${n(summary.highestModeHz)} Hz${lines.length > 0 ? `; ${lines.join('; ')}` : ''}${summary.unverified ? '; UNVERIFIED' : ''}; computed by llull, not approved.`,
      { summary, state: verified.state },
    );
  },
});

/**
 * @affects doc.analysis.cases[targetAnalysisId].loads (adds 1 gravity load `fl-<step>.<k>`) and doc.analysis.vibration.equivalentLoads (provenance)
 * @invariant source results solved and verified; the load is peakFactor x rms (g) along the probe axis in the target unit system; the peak
 *   factor is named (default 3-sigma, AF-31); provenance records case, results hash, spectrum, damping and peak factor (AF-35)
 * @failure Miles basis -> DYN_MILES_NOT_ANSWER; stale / unsolved source -> DYN_RESULTS_STALE / DYN_RESULTS_MISSING; target not static ->
 *   DYN_TARGET_NOT_STATIC; no / several of probe and nodalMax, probe not an acceleration rms -> DYN_PROBE_NOT_FOUND; bad load case name or
 *   peak factor -> FEA_LOAD_INVALID / FEA_PARAM_INVALID
 */
export const equivalentStaticLoadCase = defineCommand({
  name: 'equivalent_static_load_case',
  description:
    'Turn a random_response acceleration into a quasi-static load: adds a gravity load (acceleration vector = peakFactor x rms g along the ' +
    'probe axis, in the unit system of the static target case) to load case loadCase of targetAnalysisId, from a probe (an a_x / a_y / a_z probe ' +
    'name) or nodalMax: true (the largest nodal rms of the base-direction acceleration). peakFactor defaults to 3 (Gaussian 3-sigma, a named ' +
    'default stated in the result); give peakFactor and peakFactorSource for another value. The source results must be solved and current. ' +
    "basis 'miles' is refused: Miles' equation is a quick check, never an equivalent load. Apply the load with both signs when the sign matters. " +
    'Next: fea_mesh / fea_solve the static case and compute_margins.',
  params: z.object({
    analysisId: analysisIdSchema.describe('Id of the solved random_response case.'),
    probe: z.string().optional().describe('Name of an acceleration probe (a_x / a_y / a_z) of the random case.'),
    nodalMax: z.boolean().optional().describe('true: use the largest nodal rms of the base-direction acceleration instead of a probe.'),
    peakFactor: z.number().optional().describe('Peak factor (multiple of the rms); default 3 (named default).'),
    peakFactorSource: z.string().optional().describe('Where a non-default peak factor comes from.'),
    targetAnalysisId: z.string().describe('Id of the static analysis that receives the load.'),
    loadCase: z.string().describe('Load case name in the target (1-40 letters, digits or underscores).'),
    category: z.enum(['limit', 'ultimate']).optional().describe('Load category; default limit.'),
    basis: z.enum(['random_response', 'miles']).optional().describe("Basis of the acceleration; only 'random_response' is accepted."),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { analysisId, targetAnalysisId, loadCase } = params;
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseDyn(doc, 'equivalent_static_load_case', code, message, [analysisId], paths);
    if (params.basis === 'miles')
      return fail('DYN_MILES_NOT_ANSWER', "Miles' equation is a quick check, not an answer of record: use a random_response result", [
        'basis',
      ]);
    const verified = verifiedSummary(doc, analysisId, ctx?.feaArtifacts);
    if ('code' in verified) return fail(verified.code, verified.message, ['analysisId']);
    const target = caseOf(doc, targetAnalysisId);
    if (target === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${targetAnalysisId}'`, ['targetAnalysisId']);
    if (target.type !== 'static')
      return fail('DYN_TARGET_NOT_STATIC', `analysis '${targetAnalysisId}' is ${target.type}, not static`, ['targetAnalysisId']);
    const nameProblem = loadCaseNameProblem(loadCase);
    if (nameProblem !== null) return fail('FEA_LOAD_INVALID', nameProblem, ['loadCase']);
    if (params.peakFactor !== undefined && !(params.peakFactor >= 1 && Number.isFinite(params.peakFactor)))
      return fail('FEA_PARAM_INVALID', 'peakFactor must be >= 1', ['peakFactor']);
    if ((params.probe === undefined) === (params.nodalMax !== true))
      return fail('DYN_PROBE_NOT_FOUND', 'give exactly one of probe or nodalMax: true', ['probe']);
    const direction = verified.analysisCase.dynamics?.base?.direction ?? 'z';
    let quantity: string;
    let rms: number;
    let from: EquivalentLoadProvenance['from'];
    if (params.probe !== undefined) {
      const probe = verified.summary.probes.find(
        (entry) => entry.probe === params.probe && entry.kind === 'random' && entry.quantity.startsWith('a_'),
      );
      if (probe?.kind !== 'random') return fail('DYN_PROBE_NOT_FOUND', `no acceleration rms probe '${params.probe}'`, ['probe']);
      ({ quantity, rms } = probe);
      from = { probe: probe.probe };
    } else {
      const entry = verified.summary.nodalMax?.find((candidate) => candidate.quantity === `a_${direction}`);
      if (entry === undefined) return fail('DYN_PROBE_NOT_FOUND', `the results have no nodal a_${direction} rms field`, ['nodalMax']);
      ({ quantity, rms } = entry);
      from = { nodalMax: quantity };
    }
    const peakFactor = peakFactorOf(params.peakFactor, params.peakFactorSource);
    const axis = quantity.slice(2) as 'x' | 'y' | 'z';
    const magnitude = peakFactor.value * rms * gravityInUnitSystem(target.unitSystem);
    const vector: [number, number, number] = [axis === 'x' ? magnitude : 0, axis === 'y' ? magnitude : 0, axis === 'z' ? magnitude : 0];
    const id = nextId('fl');
    const load: FeaLoad = {
      id,
      name: `equivalent ${quantity} of ${analysisId}`,
      loadCase,
      category: params.category ?? 'limit',
      kind: 'gravity',
      vector,
    };
    const damping = verified.analysisCase.dynamics?.damping;
    const provenance: EquivalentLoadProvenance = {
      sourceAnalysisId: analysisId,
      sourceResultsHash: verified.resultsHash,
      from,
      rms,
      unit: 'g',
      peakFactor,
      spectrum: verified.analysisCase.dynamics?.base?.spectrum ?? '',
      damping: damping === undefined ? '' : damping.model,
      targetAnalysisId,
    };
    const library = libraryOf(doc);
    const next = withCase(doc, { ...target, loads: { ...target.loads, [id]: load }, loadOrder: [...target.loadOrder, id] });
    return changed(
      withLibrary(next, { ...library, equivalentLoads: { ...(library.equivalentLoads ?? {}), [id]: provenance } }),
      `equivalent_static_load_case: '${id}' gravity ${n(peakFactor.value)} x ${n(rms)} g = ${n(peakFactor.value * rms)} g along ${axis} in '${targetAnalysisId}' load case ${loadCase} (peak factor ${peakFactor.defaulted ? 'DEFAULT 3-sigma' : peakFactor.source}); computed by llull, not approved.`,
      [id],
    );
  },
});
