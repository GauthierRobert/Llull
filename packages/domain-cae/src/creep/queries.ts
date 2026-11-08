/** creep_report and check_creep: results and readiness of a `creep` case (PHY-11 FR-CRP-05, 13..17, 21; TECHNICAL_SPEC §5.5). */

import type { AnalysisCase, FeResultsArtifact, ResultsSummary } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { nortonEffectiveTime } from '@core/model/materialLaws/creep';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { toMetres } from '@core/model/units';
import { analysisLengthMetres } from '../shared/defaults';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord, type Trust } from '../shared/trust';
import { evaluateProbes } from '../results/probes';
import { execute } from '@core/commands/registry';
import { NOT_APPROVED } from '../contact/codes';
import { checkCreepItems, creepResultItems, type CreepItem } from './check';
import { refuseCrp } from './codes';
import { creepCase, isRefusal } from './stepCommands';
import { holdSets, selectIndices, MAX_HISTORY_POINTS } from './history';
import { isPartIssue, partLaw } from './readiness';
import type { CreepLaw } from './law';

const sig = (value: number): string => significantNumber(value, 5);

const REVIEW_REASON = 'creep deformation and relaxation feed structural and maintenance decisions';

/** `[code, message]` of a case whose results cannot be read, null when trusted results are at hand. */
function unreadable(trust: Trust): readonly [string, string] | null {
  if (trust.state === 'solved' && trust.resultsArtifact !== null && trust.meshArtifact !== null && trust.results !== null) return null;
  if (trust.state === 'stale') return ['FEA_RESULTS_STALE', 'the inputs changed after the solve: re-run fea_mesh and fea_solve'];
  if (trust.state === 'untrusted')
    return ['FEA_SUMMARY_MISMATCH', trust.problem?.message ?? 'a recorded summary differs from its artifact'];
  return ['CRP_RESULTS_MISSING', trust.problem?.message ?? 'no results yet: run fea_mesh and fea_solve'];
}

/** The distinct creep laws of the parts of `analysis` (one per material model), with the parts that use them. */
function lawsOf(doc: CadDocument, analysis: AnalysisCase): { readonly law: CreepLaw; readonly parts: string[] }[] {
  const found: { law: CreepLaw; parts: string[] }[] = [];
  for (const entityId of Object.keys(analysis.parts)) {
    const law = partLaw(doc, entityId);
    if (isPartIssue(law)) continue;
    const same = found.find((entry) => entry.law.materialId === law.materialId && entry.law.modelId === law.modelId);
    if (same === undefined) found.push({ law, parts: [entityId] });
    else same.parts.push(entityId);
  }
  return found;
}

/** Closed-form creep strain of a point held at the end-of-hold maximum stress for the whole hold (time hardening counts the preload period). */
function quickCheck(
  analysis: AnalysisCase,
  summary: ResultsSummary,
  laws: readonly { readonly law: CreepLaw }[],
): Record<string, unknown> | null {
  const creep = summary.creep;
  const spec = analysis.creep;
  const only = laws.length === 1 ? laws[0]?.law : undefined;
  if (creep?.maxCeeq === undefined || creep.maxVonMisesEndMPa === undefined || spec === undefined || only === undefined) return null;
  const sigma = creep.maxVonMisesEndMPa.value;
  const effectiveTime = nortonEffectiveTime(only.m, spec.preloadPeriodS, spec.preloadPeriodS + spec.durationS);
  const expected = only.A * sigma ** only.n * effectiveTime;
  return {
    check: 'norton_constant_stress',
    sigmaMPa: sigma,
    value: expected,
    ratioFeToClosedForm: expected > 0 ? creep.maxCeeq.value / expected : null,
    note: 'strain of a point held at the end-of-hold maximum von Mises for the whole hold: equal to the FE value for a uniform load-controlled uniaxial case, an indicator elsewhere (stress redistributes)',
  };
}

/** History of one probe, at most `maxPoints` points (the same log-spaced selection the document summary uses). */
function probeRecords(
  readings: ReturnType<typeof evaluateProbes>,
  probeIds: readonly string[] | undefined,
  maxPoints: number,
): Record<string, unknown> {
  const records: Record<string, unknown> = {};
  for (const reading of readings) {
    if (probeIds !== undefined && !probeIds.includes(reading.probeId)) continue;
    const points = reading.values.flatMap((entry) => (entry.value === null ? [] : [{ tS: entry.time, value: entry.value }]));
    const kept = selectIndices(
      points.map((point) => point.tS),
      maxPoints,
    ).flatMap((index) => points[index] ?? []);
    records[reading.probeId] = {
      name: reading.name,
      quantity: reading.quantity,
      unit: reading.unit,
      nodeId: reading.nodeId,
      history: kept,
      points: points.length,
      missing: reading.values.length - points.length,
    };
  }
  return records;
}

/**
 * @invariant read-only; numbers only from results re-verified against the artifact store (trustedRecord), so stale or unverifiable results are refused;
 *   histories at most `maxPoints` points per probe, hold time = CalculiX total time - preload period; `unverified` = the law flags; every result
 *   reviewRequired with a reason and the AF-33 sentence; an incomplete hold is reported in data.hold.complete, not refused
 * @failure unknown / non-creep case -> FEA_ANALYSIS_NOT_FOUND / CRP_CASE_TYPE; unknown probe id -> FEA_PROBE_NOT_FOUND; no hold set -> CRP_STEP_MISSING; stale -> FEA_RESULTS_STALE; no / unverifiable results -> CRP_RESULTS_MISSING /
 *   FEA_SUMMARY_MISMATCH (refusals, unchanged doc)
 */
export const creepReport = defineCommand({
  name: 'creep_report',
  description:
    'Results of a solved creep analysis as data: the hold (duration, last stored hold time, complete?, cetol, temperature), each part law with its ' +
    'A (MPa^-n s^-(m+1)), n, m, validity, basis and source, the largest equivalent creep strain (ceeq) and the largest von Mises at the end and over the ' +
    'hold with their positions and entities (analysis length unit, MPa), the history of each probe (hold seconds, at most maxPoints points, log-spaced ' +
    'selection that keeps the first and last), a closed-form quick check (norton_constant_stress at the end-of-hold maximum stress; the ratio FE / closed form ' +
    'is 1 for a uniform uniaxial case) and the unverified flags of the law. Time zero of the histories is the end of the elastic preload step. Refuses ' +
    'stale results. Always reviewRequired: computed by llull, not approved. Follow with check_creep.',
  annotations: { readOnly: true },
  params: z.object({
    analysisId: analysisIdSchema,
    probes: z.array(z.string()).optional().describe('Only these probe ids (affected[0] of add_result_probe); absent = every probe.'),
    maxPoints: z.number().int().min(2).max(MAX_HISTORY_POINTS).optional().describe('Most points per probe history, 2 to 200. Default 200.'),
  }),
  run: (doc, params, ctx?: ExecutionContext): CommandResult => {
    const command = 'creep_report';
    const found = creepCase(doc, command, params.analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseCrp(doc, command, code, message, [analysis.id], [path]);
    const maxPoints = params.maxPoints ?? MAX_HISTORY_POINTS;
    const unknown = (params.probes ?? []).filter((id) => !Object.hasOwn(analysis.probes, id));
    if (unknown.length > 0) return fail('FEA_PROBE_NOT_FOUND', `no probe ${unknown.map((id) => `'${id}'`).join(', ')}`, 'probes');
    if (analysis.creep === undefined) return fail('CRP_STEP_MISSING', `analysis '${analysis.id}' has no creep step`, 'analysisId');
    const trust = trustedRecord(doc, analysis, ctx?.feaArtifacts);
    const blocked = unreadable(trust);
    if (blocked !== null || trust.meshArtifact === null || trust.resultsArtifact === null || trust.results === null)
      return fail(blocked?.[0] ?? 'CRP_RESULTS_MISSING', blocked?.[1] ?? 'no results', 'analysisId');
    const summary = trust.results;
    const creep = summary.creep;
    if (creep === undefined) return fail('CRP_RESULTS_MISSING', 'the verified results hold no creep summary', 'analysisId');
    const lengthToAnalysis = toMetres(doc, 1) / analysisLengthMetres(analysis.unitSystem);
    const readings = evaluateProbes(analysis, trust.meshArtifact, trust.resultsArtifact, lengthToAnalysis);
    const laws = lawsOf(doc, analysis);
    const reasons = [...new Set(laws.flatMap(({ law }) => law.unverifiedReasons))];
    const quick = quickCheck(analysis, summary, laws);
    const spec = analysis.creep;
    const text = [
      `hold ${sig(creep.finalTimeS)} s of ${sig(spec.durationS)} s at ${sig(spec.temperature.valueK)} K${creep.holdComplete ? '' : ' (INCOMPLETE)'}`,
      creep.maxCeeq === undefined ? 'no creep strain block' : `max creep strain ${sig(creep.maxCeeq.value)} in '${creep.maxCeeq.entityId}'`,
      creep.maxVonMisesEndMPa === undefined ? '' : `max von Mises at the end ${sig(creep.maxVonMisesEndMPa.value)} MPa`,
      typeof quick?.['ratioFeToClosedForm'] === 'number' ? `quick check ratio ${sig(quick['ratioFeToClosedForm'])}` : '',
      reasons.length > 0 ? `UNVERIFIED law (${reasons.join('; ')})` : '',
    ].filter((part) => part !== '');
    return report(doc, `${command}: '${analysis.id}' ${text.join('; ')}. ${NOT_APPROVED}`, {
      analysisId: analysis.id,
      state: trust.state,
      unitSystem: analysis.unitSystem,
      hold: {
        durationS: spec.durationS,
        finalTimeS: creep.finalTimeS,
        complete: creep.holdComplete,
        outputSets: creep.outputSets,
        cetol: spec.cetol,
        temperatureK: spec.temperature.valueK,
        preloadPeriodS: spec.preloadPeriodS,
        timeOrigin: 'hold seconds = CalculiX total time minus the preload step; time hardening (m != 0) counts the preload period',
      },
      laws: laws.map(({ law, parts }) => ({
        materialId: law.materialId,
        modelId: law.modelId,
        parts,
        form: 'norton',
        A: { value: law.A, unit: 'MPa^-n s^-(m+1)' },
        n: law.n,
        m: law.m,
        validRangeK: law.temperatureRangeK,
        stressValidity: 'not declared by creep_norton laws: the maximum stress of the hold is reported, not range-checked',
        basis: law.basis,
        source: law.source,
      })),
      maxCeeq: creep.maxCeeq ?? null,
      maxVonMisesEndMPa: creep.maxVonMisesEndMPa ?? null,
      maxVonMisesOverHoldMPa: creep.maxVonMisesOverHoldMPa ?? null,
      probes: probeRecords(readings, params.probes, maxPoints),
      quickCheck: quick,
      unverified: reasons.length > 0,
      unverifiedReasons: reasons,
      provenance: {
        resultsHash: analysis.results?.resultsHash ?? null,
        inputHash: analysis.results?.inputHash ?? null,
        reader: 'frd blocks PE (CEEQ), STRESS, DISP at the *TIME POINTS of the hold step',
      },
      reviewRequired: true,
      reviewReason: REVIEW_REASON,
    });
  },
});

const statusOf = (items: readonly CreepItem[]): 'pass' | 'warn' | 'fail' =>
  items.some((entry) => entry.severity === 'error') ? 'fail' : items.length > 0 ? 'warn' : 'pass';

/** The `check_analysis` items (05 first, TECHNICAL_SPEC §4): composed through `execute`, never reimplemented. */
function baseItems(doc: CadDocument, analysisId: string, ctx: ExecutionContext | undefined): CreepItem[] {
  const result = execute(doc, 'check_analysis', { analysisId }, ctx);
  const items = (result.data as { items?: readonly CreepItem[] } | undefined)?.items;
  return items === undefined ? [] : [...items];
}

/**
 * @invariant read-only; the check_analysis items first (they include the creep set-up items: hold, laws, temperature validity, orthotropy, unverified,
 *   overstress), then the hold of verified results (CRP_HOLD_INCOMPLETE); status fail on any error, warn on warnings only; reviewRequired always;
 *   duplicates removed by code and ids
 * @failure unknown / non-creep case -> FEA_ANALYSIS_NOT_FOUND / CRP_CASE_TYPE (refusals, unchanged doc)
 */
export const checkCreep = defineCommand({
  name: 'check_creep',
  description:
    'Check a creep analysis end to end and return data { analysisId, state, status pass | warn | fail, items [{ code, severity, ids, message, remediation }], ' +
    'notes, reviewRequired: true }: the check_analysis items (parts, supports, mesh, stale results) plus the creep ones - no hold (CRP_STEP_MISSING), a part ' +
    'without a creep law (CRP_LAW_MISSING, CRP_NO_VISCOUS_MATERIAL, CRP_LAW_FORM_UNSUPPORTED), a law with timeUnit other than s (CRP_LAW_TIME_UNIT), the hold temperature ' +
    'outside the law validity (CRP_LAW_OUT_OF_RANGE), orthotropic elasticity (CRP_ORTHOTROPIC_V2), unverified law (CRP_LAW_UNVERIFIED, warning, not suppressible), plastic ' +
    'model beside creep (CRP_OVERSTRESS_MODEL, warning) and, on verified results, a hold that stopped early (CRP_HOLD_INCOMPLETE). Run it before fea_mesh / fea_solve ' +
    'and after the solve.',
  annotations: { readOnly: true },
  params: z.object({ analysisId: analysisIdSchema }),
  run: (doc, params, ctx?: ExecutionContext): CommandResult => {
    const command = 'check_creep';
    const found = creepCase(doc, command, params.analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const trust = trustedRecord(doc, analysis, ctx?.feaArtifacts);
    const seen = new Set<string>();
    const items = [
      ...baseItems(doc, analysis.id, ctx),
      ...checkCreepItems(doc, analysis),
      ...(trust.state === 'solved' ? creepResultItems(analysis, trust.results ?? undefined) : []),
    ].filter((entry) => {
      const key = `${entry.code}|${entry.ids.join(',')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const notes: string[] = [];
    if (trust.state !== 'solved') notes.push(`result checks skipped: no current verified results (state ${trust.state})`);
    else {
      const results: FeResultsArtifact | null = trust.resultsArtifact;
      if (results !== null && holdSets(analysis, results).length === 0) notes.push('the results hold no stored set of the hold step');
      notes.push(
        'the stress range of the law is not declared by creep_norton: maxVonMisesOverHoldMPa in creep_report is the value to compare with the data range',
      );
    }
    const status = statusOf(items);
    return report(
      doc,
      `${command}: '${analysis.id}' ${status} (${items.length} item(s)${items.length > 0 ? `: ${[...new Set(items.map((entry) => entry.code))].join(', ')}` : ''}). ${NOT_APPROVED}`,
      { analysisId: analysis.id, state: trust.state, status, items, notes, reviewRequired: true },
    );
  },
});
