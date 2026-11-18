/** compute_margins query checks: parameters that contradict the criterion / analysis, and the re-verified artifacts of a case. */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { loadCasesOf } from '../decks/context';

interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

/** The query fields the checks read. */
interface QueryChecks {
  readonly joint?: unknown;
  readonly limitLoad?: unknown;
  readonly singularityRadius?: number | undefined;
  readonly singularityNote?: string | undefined;
  readonly loadCases?: string[] | undefined;
}

export const refusalFor = (analysisId: string, code: string, message: string): Refusal => ({ code, message, ids: [analysisId] });

/** The refusal for query parameters that contradict the criterion, the analysis type or the load cases, or null. */
export function queryRefusal(analysis: AnalysisCase, analysisId: string, query: QueryChecks): Refusal | null {
  const refuse = (code: string, message: string): Refusal => refusalFor(analysisId, code, message);
  if (query.joint !== undefined) return refuse('FEA_MARGIN_PARAM_INVALID', 'joint applies to criterion joint only');
  if (query.limitLoad !== undefined) return refuse('FEA_MARGIN_PARAM_INVALID', 'limitLoad applies to criterion limit_load only');
  if (analysis.type !== 'static' && analysis.type !== 'thermo_static')
    return refuse('FEA_ANALYSIS_TYPE_UNSUPPORTED', `margins need structural results; '${analysisId}' is ${analysis.type}`);
  const { singularityRadius, singularityNote } = query;
  if (singularityRadius !== undefined && !(Number.isFinite(singularityRadius) && singularityRadius >= 0))
    return refuse(
      'FEA_MARGIN_PARAM_INVALID',
      `singularityRadius ${singularityRadius} must be a finite number >= 0 (document length units)`,
    );
  if (singularityRadius !== undefined && (singularityNote ?? '').trim() === '')
    return refuse(
      'FEA_MARGIN_PARAM_INVALID',
      'singularityNote: a singularityRadius override needs a non-empty engineering justification (singularityNote)',
    );
  const known = loadCasesOf(analysis).map((entry) => entry.name);
  const unknown = (query.loadCases ?? []).filter((name) => !known.includes(name));
  if (unknown.length > 0)
    return refuse('FEA_MARGIN_PARAM_INVALID', `unknown load case(s) ${unknown.join(', ')}; the analysis has ${known.join(', ')}`);
  return null;
}

/** The trust verdict fields the artifact check reads (the verdict itself comes from the caller). */
interface TrustView {
  readonly state: string;
  readonly problem: { readonly code: string; readonly message: string } | null;
  readonly meshArtifact: FeMeshArtifact | null;
  readonly resultsArtifact: FeResultsArtifact | null;
}

/** The verified mesh and results artifacts of a case, or the refusal for stale, untrusted or missing ones. */
export function verifiedArtifacts(
  analysis: AnalysisCase,
  trust: TrustView,
): { readonly mesh: FeMeshArtifact; readonly results: FeResultsArtifact } | Refusal {
  const analysisId = analysis.id;
  if (trust.state === 'stale' && analysis.results !== undefined)
    return refusalFor(analysisId, 'FEA_RESULTS_STALE', `the results of '${analysisId}' predate a change of its inputs`);
  if (trust.state === 'untrusted')
    return refusalFor(
      analysisId,
      trust.problem?.code ?? 'FEA_SUMMARY_MISMATCH',
      trust.problem?.message ?? 'the recorded summary differs from its artifact',
    );
  if (trust.resultsArtifact === null || trust.meshArtifact === null)
    return refusalFor(
      analysisId,
      'FEA_RESULTS_MISSING',
      `analysis '${analysisId}' has no verified results (${trust.problem?.message ?? `state ${trust.state}`})`,
    );
  return { mesh: trust.meshArtifact, results: trust.resultsArtifact };
}
