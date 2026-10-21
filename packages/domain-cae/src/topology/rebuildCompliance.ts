/** Compliance ratio of a rebuilt solid (TR-TOP-10): F^T u from its current 05 results artifact over the compliance of the optimum. */

import type { AnalysisCase, FeArtifactPort, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { TopologyStudy } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import { unitSystemFactors } from '../decks/units';
import { loadCasesOf } from '../decks/context';
import { analysisOf } from '../shared/access';
import { trustedRecord } from '../shared/trust';
import { stepOfLoadCase } from '../results/fields';

export interface RebuildCompliance {
  readonly available: true;
  /** Id of the 05 analysis of the rebuilt solid. */
  readonly analysisId: string;
  /** Weighted F^T u of the rebuild and the compliance of the optimum, both in N*mm. */
  readonly rebuildNmm: number;
  readonly optimumNmm: number;
  readonly ratio: number;
}

export interface ComplianceUnavailable {
  readonly available: false;
  readonly code: 'TOP_REBUILD_NOT_ANALYSED';
  readonly reason: 'no_analysis' | 'not_solved' | 'stale' | 'unverified' | 'unsupported' | 'optimum_zero';
  readonly message: string;
}

const unavailable = (reason: ComplianceUnavailable['reason'], message: string): ComplianceUnavailable => ({
  available: false,
  code: 'TOP_REBUILD_NOT_ANALYSED',
  reason,
  message,
});

/** F^T u of one load case: sum over the nodes of its force loads of force x displacement, or the reason it cannot be rebuilt. */
function externalWork(
  analysis: AnalysisCase,
  name: string,
  index: number,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
): number | string {
  const displacement = stepOfLoadCase(results, index)?.fields['DISP']?.values;
  if (displacement === undefined) return `load case '${name}' has no displacement field in the results`;
  let work = 0;
  for (const id of analysis.loadOrder) {
    const load = analysis.loads[id];
    if (load === undefined || load.loadCase !== name) continue;
    if (load.kind !== 'force' || load.vector === undefined)
      return `load '${id}' is a ${load.kind}: only nodal force loads give F^T u from the artifact`;
    const nodes = Object.hasOwn(mesh.nodeSets, `L_${id}`) ? (mesh.nodeSets[`L_${id}`] ?? []) : [];
    if (nodes.length === 0) return `force '${id}' has no nodes in the mesh`;
    const share = load.distribution === 'per_node' ? 1 : 1 / nodes.length;
    for (const node of nodes) {
      const u = Object.hasOwn(displacement, String(node)) ? displacement[String(node)] : undefined;
      if (u === undefined) return `node ${node} of force '${id}' has no displacement`;
      work += share * load.vector.reduce((sum, component, axis) => sum + component * (u[axis] ?? 0), 0);
    }
  }
  return work;
}

/**
 * Ratio of the weighted compliance F^T u of the solid `entityId` (first static analysis that has it as a part) to `optimumCompliance` of the study.
 * @invariant uses only an artifact-verified, non-stale 05 result (`trustedRecord` solved); weights are the study's load case weights; both
 *   compliances are converted to N*mm; only the load cases of the optimum are summed
 * @failure no analysis of the entity, unsolved, stale, unverifiable, non-force load, missing displacement -> ComplianceUnavailable
 */
export function rebuildCompliance(
  doc: CadDocument,
  study: TopologyStudy,
  optimumCompliance: number,
  optimumLoadCases: readonly string[],
  entityId: string,
  port: FeArtifactPort | null | undefined,
): RebuildCompliance | ComplianceUnavailable {
  const model = analysisOf(doc);
  const analysis = model.caseOrder
    .map((id) => model.cases[id])
    .find((candidate) => candidate?.type === 'static' && Object.hasOwn(candidate.parts, entityId));
  if (analysis === undefined) return unavailable('no_analysis', `no static 05 analysis has '${entityId}' as a part`);
  const trust = trustedRecord(doc, analysis, port);
  if (trust.state === 'stale') return unavailable('stale', `the 05 results of ${analysis.id} are stale: re-run fea_mesh and fea_solve`);
  if (trust.state === 'unmeshed' || trust.state === 'meshed')
    return unavailable('not_solved', `the 05 analysis ${analysis.id} of '${entityId}' has no results`);
  if (trust.state !== 'solved' || trust.meshArtifact === null || trust.resultsArtifact === null)
    return unavailable(
      'unverified',
      trust.problem?.message ?? `the 05 results of ${analysis.id} cannot be verified against their artifacts`,
    );
  const names = loadCasesOf(analysis).map((entry) => entry.name);
  let rebuild = 0;
  for (const name of optimumLoadCases) {
    const index = names.indexOf(name);
    if (index < 0) return unavailable('unsupported', `analysis ${analysis.id} has no load case '${name}' of the optimum`);
    const work = externalWork(analysis, name, index, trust.meshArtifact, trust.resultsArtifact);
    if (typeof work === 'string') return unavailable('unsupported', work);
    rebuild += (study.objective.loadCaseWeights[name] ?? 1) * work;
  }
  const optimumNmm = optimumCompliance * unitSystemFactors(model.cases[study.analysisId]?.unitSystem ?? 'N-mm-t-s').nmmPerForceLength;
  if (!(optimumNmm > 0)) return unavailable('optimum_zero', 'the compliance of the optimum is not positive');
  const rebuildNmm = rebuild * unitSystemFactors(analysis.unitSystem).nmmPerForceLength;
  return { available: true, analysisId: analysis.id, rebuildNmm, optimumNmm, ratio: rebuildNmm / optimumNmm };
}
