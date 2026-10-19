/**
 * Trust model of a recorded topology result (05 4.1): the summary in the document is a CLAIM about an artifact. Every read path that shows
 * numbers asks `trustedTopology`, which recomputes the summary from the artifact with the summariser `record_topology_result` uses.
 */

import type { FeArtifactPort } from '@core/model/analysis';
import type { FeTopologyArtifact, TopologyResultSummary, TopologyStudy } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import { differingKeys, fetchArtifact } from '../shared/trust';
import { decodeField, topologySummary } from './artifact';
import { topologyInputHash, topologySettingsHash } from './hash';

/** unsolved (no result) | missing (recorded without its artifact, or the artifact is not on this machine) | stale (inputs changed) | solved | untrusted (the record differs from its artifact). */
type TopologyState = 'unsolved' | 'solved' | 'stale' | 'missing' | 'untrusted';

export interface TrustedTopology {
  readonly state: TopologyState;
  /** Summary recomputed from the artifact; null unless `state` is `solved` (a stale or unverifiable record shows no numbers). */
  readonly summary: TopologyResultSummary | null;
  readonly artifact: FeTopologyArtifact | null;
  readonly field: Float32Array | null;
  readonly problem: { readonly code: string; readonly message: string } | null;
}

const nothing = (state: TopologyState, problem: TrustedTopology['problem'] = null): TrustedTopology => ({
  state,
  summary: null,
  artifact: null,
  field: null,
  problem,
});

/** State from the hashes alone (no artifact is read, so `solved` here still has to pass `trustedTopology` before any number is shown). */
function topologyStateOf(doc: CadDocument, study: TopologyStudy): TopologyState {
  const result = study.result;
  if (result === undefined) return 'unsolved';
  if (result.verified === false) return 'missing';
  return result.inputHash === topologyInputHash(doc, study) && result.settingsHash === topologySettingsHash(study.settings)
    ? 'solved'
    : 'stale';
}

/**
 * State of the study with its record RE-VERIFIED against the artifact in `port`.
 * @invariant `solved` only when the recorded summary equals the one recomputed from the artifact; no port, an absent artifact or a
 *   `verified: false` record gives `missing`; a differing summary or an artifact that does not hash to its name gives `untrusted`
 */
export function trustedTopology(doc: CadDocument, study: TopologyStudy, port: FeArtifactPort | null | undefined): TrustedTopology {
  const base = topologyStateOf(doc, study);
  const record = study.result;
  if (base !== 'solved' || record === undefined) {
    return nothing(
      base,
      base === 'missing'
        ? { code: 'TOP_ARTIFACT_NOT_FOUND', message: 'the result was recorded without its artifact: run topology_solve here' }
        : null,
    );
  }
  const fetched = fetchArtifact(port, record.fieldHash, 'fe_topology');
  if ('code' in fetched)
    return fetched.code === 'FEA_SUMMARY_MISMATCH'
      ? nothing('untrusted', { code: 'TOP_SUMMARY_MISMATCH', message: fetched.message })
      : nothing('missing', { code: 'TOP_ARTIFACT_NOT_FOUND', message: fetched.message });
  const expected = topologySummary(doc, study, fetched.artifact, record.fieldHash);
  if (typeof expected === 'string') return nothing('untrusted', { code: 'TOP_SUMMARY_MISMATCH', message: expected });
  const differing = differingKeys(record, expected);
  if (differing.length > 0)
    return nothing('untrusted', {
      code: 'TOP_SUMMARY_MISMATCH',
      message: `the recorded summary differs from the one recomputed from its artifact in: ${differing.join(', ')}`,
    });
  return { state: 'solved', summary: expected, artifact: fetched.artifact, field: decodeField(fetched.artifact), problem: null };
}
