/** Trust model of a recorded explicit result (05 §4.1): the document's summary is a claim, re-verified against the artifact on every read. */

import type { AnalysisCase, FeArtifactPort } from '@core/model/analysis';
import type { ExplicitResultsSummary, FeExplicitArtifact } from '@core/model/explicit';
import type { CadDocument } from '@core/model/types';
import { differingKeys, fetchArtifact } from '../shared/trust';
import { explicitSummary } from './artifact';
import { explicitInputHash } from './hash';

type ExplicitState = 'unsolved' | 'solved' | 'stale' | 'missing' | 'untrusted';

export interface ExplicitTrust {
  readonly state: ExplicitState;
  /** The summary recomputed from the artifact; null unless `solved`. */
  readonly summary: ExplicitResultsSummary | null;
  readonly artifact: FeExplicitArtifact | null;
  readonly problem: { readonly code: string; readonly message: string } | null;
}

const none = (state: ExplicitState, problem: ExplicitTrust['problem']): ExplicitTrust => ({
  state,
  summary: null,
  artifact: null,
  problem,
});

/** State of the case's recorded result with its numbers RE-VERIFIED against the artifact store. */
export function trustedExplicit(doc: CadDocument, analysisCase: AnalysisCase, port: FeArtifactPort | null | undefined): ExplicitTrust {
  const recorded = analysisCase.explicit?.results;
  if (recorded === undefined) return none('unsolved', { code: 'EXP_RESULTS_MISSING', message: 'no run recorded' });
  if (recorded.inputHash !== explicitInputHash(doc, analysisCase))
    return none('stale', { code: 'EXP_RESULT_STALE', message: 'the set-up changed after the run' });
  if (recorded.verified === false)
    return none('missing', {
      code: 'EXP_ARTIFACT_NOT_FOUND',
      message: 'the result was recorded without its artifact: re-run explicit_run',
    });
  const fetched = fetchArtifact(port, recorded.artifactHash, 'fe_explicit', 'EXP');
  if ('code' in fetched) return none(fetched.code === 'EXP_SUMMARY_MISMATCH' ? 'untrusted' : 'missing', fetched);
  const summary = explicitSummary(doc, analysisCase, fetched.artifact, recorded.artifactHash);
  if (typeof summary === 'string') return none('untrusted', { code: 'EXP_SUMMARY_MISMATCH', message: summary });
  const differing = differingKeys(recorded, summary);
  if (differing.length > 0)
    return none('untrusted', {
      code: 'EXP_SUMMARY_MISMATCH',
      message: `the recorded summary differs from the one recomputed from its artifact in: ${differing.join(', ')}`,
    });
  return { state: 'solved', summary, artifact: fetched.artifact, problem: null };
}
