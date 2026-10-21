/**
 * Trust model of recorded summaries (05 §4.1, TR-FEA-05): a summary in the document is a CLAIM about an artifact. Every read path that shows
 * numbers asks `trustedRecord`, which recomputes the summary from the artifact with the same summariser the record commands use.
 */

import type { AnalysisCase, FeArtifactPort, FeMeshArtifact, FeResultsArtifact, MeshSummary, ResultsSummary } from '@core/model/analysis';
import type { FeExplicitArtifact } from '@core/model/explicit';
import type { FeTopologyArtifact } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { meshSummary, resultsSummary } from '../results/summary';
import { stateOf, type AnalysisState } from './state';

interface TrustProblem {
  readonly code: string;
  readonly message: string;
}

export interface Trust {
  readonly state: AnalysisState;
  /** Summaries recomputed from the artifacts; null whenever they could not be verified (their recorded numbers must not be shown). */
  readonly mesh: MeshSummary | null;
  readonly results: ResultsSummary | null;
  readonly meshArtifact: FeMeshArtifact | null;
  readonly resultsArtifact: FeResultsArtifact | null;
  readonly problem: TrustProblem | null;
}

/** Derived diagnostics re-computed on every read whose formula evolves between versions (the mesh `quality`): never compared. */
const DIAGNOSTIC_KEYS: ReadonlySet<string> = new Set(['quality']);

/** Top-level keys whose values differ between two summaries (derived diagnostics excluded, so older recorded ones stay trusted). */
export const differingKeys = (given: object, expected: object): string[] => {
  const left = new Map(Object.entries(given));
  const right = new Map(Object.entries(expected));
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((key) => !DIAGNOSTIC_KEYS.has(key))
    .filter((key) => canonicalJson(left.get(key)) !== canonicalJson(right.get(key)))
    .sort();
};

/**
 * The heat balance is a diagnostic re-derived from the artifact on every read (what readers show is the recomputed summary), and its
 * quadrature evolves between versions: it is left out of the comparison so results recorded by an older summariser stay trusted.
 */
function withoutHeatBalance(summary: ResultsSummary): object {
  if (summary.thermal === undefined) return summary;
  const thermal = Object.fromEntries(Object.entries(summary.thermal).filter(([key]) => key !== 'heatBalance'));
  return { ...summary, thermal };
}

type StoredArtifact = FeMeshArtifact | FeResultsArtifact | FeTopologyArtifact | FeExplicitArtifact;

const artifactHashes = new WeakMap<object, string>();

/** sha256 of the canonical JSON of an artifact, computed once per artifact object. */
function hashOfArtifact(artifact: StoredArtifact): string {
  let hash = artifactHashes.get(artifact);
  if (hash === undefined) {
    hash = sha256Hex(canonicalJson(artifact));
    artifactHashes.set(artifact, hash);
  }
  return hash;
}

export type Fetched<T> = { readonly artifact: T } | { readonly code: string; readonly message: string };

/**
 * The artifact of `hash` from the port; `codePrefix` names the refusal codes (`<prefix>_ARTIFACT_NOT_FOUND` / `<prefix>_SUMMARY_MISMATCH`).
 * @failure no port / not in the store / other kind -> FEA_ARTIFACT_NOT_FOUND; content not hashing to `hash` -> FEA_SUMMARY_MISMATCH
 */
export function fetchArtifact<K extends StoredArtifact['kind']>(
  port: FeArtifactPort | null | undefined,
  hash: string,
  kind: K,
  codePrefix: 'FEA' | 'EXP' = 'FEA',
): Fetched<Extract<StoredArtifact, { kind: K }>> {
  const found = port?.get(hash) ?? null;
  if (found === null || found.kind !== kind)
    return {
      code: `${codePrefix}_ARTIFACT_NOT_FOUND`,
      message: port ? `no ${kind} artifact for hash ${hash}` : `no artifact store available for ${kind} ${hash}`,
    };
  if (hashOfArtifact(found) !== hash)
    return { code: `${codePrefix}_SUMMARY_MISMATCH`, message: `the sha256 of the ${kind} artifact is not ${hash}` };
  return { artifact: found as Extract<StoredArtifact, { kind: K }> };
}

const nothing = (state: AnalysisState, problem: TrustProblem | null): Trust => ({
  state,
  mesh: null,
  results: null,
  meshArtifact: null,
  resultsArtifact: null,
  problem,
});

const mismatch = (message: string, code = 'FEA_SUMMARY_MISMATCH'): TrustProblem => ({ code, message });

/**
 * State of the case with the summaries RE-VERIFIED against the artifacts in `port`.
 * @invariant `solved` / `meshed` only when every recorded summary equals the one recomputed from its artifact; `mesh` / `results` are the
 *   recomputed summaries (never the recorded ones); no port, a missing artifact or a `verified: false` record gives `missing` (`stale` stays
 *   `stale`), a differing summary or an artifact whose content does not hash to its name gives `untrusted` with FEA_SUMMARY_MISMATCH; the
 *   results of a `stale` case are withheld
 */
export function trustedRecord(doc: CadDocument, analysisCase: AnalysisCase, port: FeArtifactPort | null | undefined): Trust {
  const base = stateOf(doc, analysisCase);
  const meshRecord = analysisCase.meshSummary;
  if (base === 'unmeshed' || meshRecord === undefined) return nothing('unmeshed', null);
  if (base === 'missing')
    return nothing(
      'missing',
      mismatch('the summary was recorded without its artifact: re-run fea_mesh / fea_solve', 'FEA_ARTIFACT_NOT_FOUND'),
    );
  const absent = base === 'stale' ? 'stale' : 'missing';
  if (port === null || port === undefined)
    return nothing(
      absent,
      mismatch('no artifact store on this machine: the recorded summary cannot be verified', 'FEA_ARTIFACT_NOT_FOUND'),
    );
  const meshFetched = fetchArtifact(port, meshRecord.meshHash, 'fe_mesh');
  if ('code' in meshFetched) return nothing(meshFetched.code === 'FEA_SUMMARY_MISMATCH' ? 'untrusted' : absent, meshFetched);
  const mesh = meshSummary(meshFetched.artifact, meshRecord.meshHash);
  const meshDiff = differingKeys(meshRecord, mesh);
  if (meshDiff.length > 0)
    return nothing(
      'untrusted',
      mismatch(`the recorded mesh summary differs from the one recomputed from its artifact in: ${meshDiff.join(', ')}`),
    );
  const verifiedMesh: Trust = { ...nothing(base, null), mesh, meshArtifact: meshFetched.artifact };
  const resultsRecord = analysisCase.results;
  if (resultsRecord === undefined || base === 'stale') return verifiedMesh;
  const resultsFetched = fetchArtifact(port, resultsRecord.resultsHash, 'fe_results');
  if ('code' in resultsFetched)
    return resultsFetched.code === 'FEA_SUMMARY_MISMATCH'
      ? nothing('untrusted', resultsFetched)
      : { ...verifiedMesh, state: 'missing', problem: resultsFetched };
  if (resultsFetched.artifact.meshHash !== meshRecord.meshHash)
    return nothing(
      'untrusted',
      mismatch(
        `the results were computed on mesh ${resultsFetched.artifact.meshHash}, the recorded mesh is ${meshRecord.meshHash}`,
        'FEA_MESH_MISMATCH',
      ),
    );
  const results = resultsSummary(doc, analysisCase.id, meshFetched.artifact, resultsFetched.artifact, resultsRecord.resultsHash);
  const resultsDiff = differingKeys(withoutHeatBalance(resultsRecord), withoutHeatBalance(results));
  if (resultsDiff.length > 0)
    return nothing(
      'untrusted',
      mismatch(`the recorded results summary differs from the one recomputed from its artifact in: ${resultsDiff.join(', ')}`),
    );
  return { ...verifiedMesh, results, resultsArtifact: resultsFetched.artifact };
}
