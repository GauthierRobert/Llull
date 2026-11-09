/** The limit load of a curve probe of a SOLVED nonlinear_static case, from the trusted results artifact (shared by limit_load and compute_margins). */

import type { AnalysisCase, CurveProbe, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import type { ExecutionContext } from '@core/commands/types';
import { z } from '@core/commands/schema';
import { elasticConstants, isElasticRefusal, propertyTemperatureK } from '../decks/elastic';
import { lengthUnitName, stressUnitName } from '../decks/units';
import { caseOf } from '../shared/access';
import { trustedRecord } from '../shared/trust';
import { extractCurves, type CurveData } from './curves';
import { limitLoadOf, type LimitLoad, type LimitMethod, type PlateauParams } from './limitLoad';

export const limitLoadShape = {
  probe: z.string().describe('Curve probe of the case: its id (affected[0] of add_curve_probe) or its unique name.'),
  method: z
    .enum(['peak', 'plateau', 'auto'])
    .describe(
      'peak: first load maximum with the displacement still increasing, refined by a parabola (displacement-controlled runs); plateau: where the secant slope over plateau.window drops below plateau.slopeFraction x the initial slope (perfectly plastic collapse); auto: peak if the curve has a maximum, else not reached.',
    ),
  plateau: z
    .object({
      slopeFraction: z.number().describe('Fraction of the initial slope, 0 < f < 1, no default (e.g. 0.02).'),
      window: z.number().describe('Secant window in the curve displacement unit (analysis length unit), > 0, no default.'),
    })
    .optional()
    .describe('REQUIRED for method plateau (no defaults, refused with NLS_PLATEAU_PARAMS_UNSET); ignored otherwise.'),
};

export interface LimitLoadQuery {
  readonly probe: string;
  readonly method: LimitMethod;
  readonly plateau?: PlateauParams | undefined;
}

export interface LimitLoadReport {
  readonly analysis: AnalysisCase;
  readonly probe: CurveProbe;
  readonly curve: CurveData;
  readonly result: LimitLoad;
  readonly curveHash: string;
  readonly resultsHash: string;
  readonly results: FeResultsArtifact;
  readonly mesh: FeMeshArtifact | null;
  /** Unit of the curve load axis: force for reactions and force loads, stress for a pressure, force x length for a moment. */
  readonly loadUnit: string;
  readonly lengthUnit: string;
  readonly warnings: readonly string[];
  readonly unverifiedReasons: readonly string[];
  readonly provenance: Record<string, unknown>;
}

export interface LimitLoadRefusal {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
}

/** The probe whose id or unique name is `reference`. */
function probeOf(analysis: AnalysisCase, reference: string): CurveProbe | undefined {
  const probes = analysis.nonlinear?.probes ?? {};
  if (Object.hasOwn(probes, reference)) return probes[reference];
  const named = Object.values(probes).filter((probe) => probe.name === reference);
  return named.length === 1 ? named[0] : undefined;
}

/** E / nu unverified reasons of the materials of the parts (AF-32: they flag every number computed from them). */
function unverifiedReasons(doc: CadDocument, analysis: AnalysisCase): string[] {
  const reasons = new Set<string>();
  for (const entityId of Object.keys(analysis.parts)) {
    const materialId = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId]?.materialId : undefined;
    const material = materialId !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
    if (material === undefined || materialId === undefined) continue;
    const elastic = elasticConstants(material, materialId, propertyTemperatureK(analysis));
    if (!isElasticRefusal(elastic)) for (const reason of elastic.unverifiedReasons) reasons.add(`E/nu of '${materialId}': ${reason}`);
  }
  return [...reasons];
}

/** Unit of the load axis of a probe: what the curve load really is (a pressure probe plots a pressure, not a force). */
function loadUnitOf(analysis: AnalysisCase, probe: CurveProbe): string {
  const force = analysis.unitSystem.split('-')[0] ?? '';
  if (probe.load.kind === 'reaction') return force;
  const load = Object.hasOwn(analysis.loads, probe.load.loadId) ? analysis.loads[probe.load.loadId] : undefined;
  if (load?.kind === 'pressure') return stressUnitName(analysis.unitSystem);
  if (load?.kind === 'moment') return `${force}*${lengthUnitName(analysis.unitSystem)}`;
  if (load?.kind === 'gravity' || load?.kind === 'inertial') return `${lengthUnitName(analysis.unitSystem)}/s^2`;
  return force;
}

const RULES: Readonly<Record<LimitMethod, string>> = {
  peak: 'first i with P[i] >= P[i-1], P[i+1] < P[i] and the displacement increasing; parabola vertex through (i-1, i, i+1) in (d, P)',
  plateau: 'first d where the secant slope over [d, d + window] < slopeFraction x the initial slope; limit = P(d)',
  auto: 'peak if the curve has a maximum, else not reached (largest load as a lower bound)',
};

/**
 * @invariant pure; numbers only from the results artifact re-verified by trustedRecord; magnitudes in the analysis force / length units
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not nonlinear_static -> NLS_CASE_NOT_NONLINEAR; unknown probe -> NLS_PROBE_REFERENCE_UNKNOWN;
 *   plateau without both parameters in range -> NLS_PLATEAU_PARAMS_UNSET; stale results -> NLS_CURVE_STALE; untrusted -> FEA_SUMMARY_MISMATCH;
 *   no verified results -> FEA_RESULTS_MISSING
 */
export function limitLoadReport(
  doc: CadDocument,
  analysisId: string,
  query: LimitLoadQuery,
  ctx: ExecutionContext | undefined,
): LimitLoadReport | LimitLoadRefusal {
  const refuse = (code: string, message: string, paths: readonly string[] = []): LimitLoadRefusal => ({
    code,
    message,
    ids: [analysisId],
    paths,
  });
  const analysis = caseOf(doc, analysisId);
  if (analysis === undefined) return refuse('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, ['analysisId']);
  if (analysis.type !== 'nonlinear_static')
    return refuse('NLS_CASE_NOT_NONLINEAR', `analysis '${analysisId}' is ${analysis.type}: limit loads come from nonlinear_static curves`, [
      'analysisId',
    ]);
  const probe = probeOf(analysis, query.probe);
  if (probe === undefined)
    return refuse(
      'NLS_PROBE_REFERENCE_UNKNOWN',
      `no curve probe '${query.probe}' in '${analysisId}' (probes: ${(analysis.nonlinear?.probeOrder ?? []).join(', ') || 'none'})`,
      ['probe'],
    );
  const { plateau } = query;
  if (
    query.method === 'plateau' &&
    !(plateau !== undefined && plateau.slopeFraction > 0 && plateau.slopeFraction < 1 && plateau.window > 0)
  )
    return refuse(
      'NLS_PLATEAU_PARAMS_UNSET',
      'method plateau needs plateau { slopeFraction (0 < f < 1), window (> 0) }: there are no defaults',
      ['plateau'],
    );
  const trust = trustedRecord(doc, analysis, ctx?.feaArtifacts);
  if (trust.state === 'stale')
    return refuse('NLS_CURVE_STALE', `the curves of '${analysisId}' predate a change of its inputs: fea_mesh + fea_solve again`);
  if (trust.state === 'untrusted')
    return refuse(trust.problem?.code ?? 'FEA_SUMMARY_MISMATCH', trust.problem?.message ?? 'untrusted results');
  const results = trust.resultsArtifact;
  if (results === null || trust.results === null)
    return refuse(
      'FEA_RESULTS_MISSING',
      `analysis '${analysisId}' has no verified results (${trust.problem?.message ?? `state ${trust.state}`})`,
    );
  const curve = extractCurves(analysis, results).find((entry) => entry.probeId === probe.id);
  const summary = trust.results.nonlinear?.curves.find((entry) => entry.probeId === probe.id);
  if (curve === undefined || summary === undefined)
    return refuse(
      'FEA_RESULTS_MISSING',
      `the results of '${analysisId}' hold no curve for probe '${probe.id}' (solved before it was added?)`,
    );
  const result = limitLoadOf(curve.load, curve.displacement, query.method, plateau);
  const warnings: string[] = [];
  if (result.found === 'not_reached')
    warnings.push(
      `NLS_LIMIT_NOT_REACHED: curve '${probe.name}' has no ${query.method === 'plateau' ? 'plateau' : 'maximum'}: ${result.lowerBound} is a lower bound of the limit load (extend the controlled displacement)`,
    );
  if ((analysis.studyOrder ?? []).length === 0)
    warnings.push(
      'VNV_NO_CONVERGENCE_STUDY: no PHY-00 mesh convergence study on this case: the limit load is mesh dependent (check_convergence)',
    );
  return {
    analysis,
    probe,
    curve,
    result,
    curveHash: summary.curveHash,
    resultsHash: analysis.results?.resultsHash ?? '',
    results,
    mesh: trust.meshArtifact,
    loadUnit: loadUnitOf(analysis, probe),
    lengthUnit: lengthUnitName(analysis.unitSystem),
    warnings,
    unverifiedReasons: unverifiedReasons(doc, analysis),
    provenance: {
      method: query.method,
      rule: RULES[query.method],
      ...(plateau !== undefined && query.method === 'plateau' ? { plateau: { ...plateau, source: 'caller (no default, AF-31)' } } : {}),
      convergenceStudies: analysis.studyOrder ?? [],
      source: 'docs/physics/05-nonlinear-structural/TECHNICAL_SPEC.md 5.7',
    },
  };
}
