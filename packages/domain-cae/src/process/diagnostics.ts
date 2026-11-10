/** Findings of an AM case that need the mesh (and the results): empty layers, probes on built nodes, large deflection (PHY-16 §7.1). */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact, ResultsSummary } from '@core/model/analysis';
import { nearestNode } from '../results/probes';
import { amLayerPlan } from './layers';
import { amLoadCases } from './results';

export interface AmFinding {
  readonly code: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
  readonly ids: readonly string[];
}

/** A phase displacement above this fraction of the largest mesh extent leaves the small-displacement regime the layer activation is validated in (measured: 5 % drift at 3 %). */
const LARGE_DEFLECTION_RATIO = 0.01;

/**
 * Findings of the mesh: PRC_LAYER_MESH_MISMATCH (error: every empty geometric layer lies below the top one, so its thickness is lumped into the next layer and the
 * strain history is wrong) and PRC_PROBE_ON_BUILT_NODE (warning: the nearest node of a probe belongs to no plate, support or first-layer element, so CalculiX reads
 * its displacement since its own activation, measured 0.24 of the true curvature).
 * @invariant empty without a build set-up or a layer plan; deterministic, in probe-id order
 */
export function amMeshFindings(analysis: AnalysisCase, mesh: FeMeshArtifact, lengthToAnalysis: number): AmFinding[] {
  const { am } = analysis;
  if (am === undefined) return [];
  const plan = amLayerPlan(analysis, am, mesh, lengthToAnalysis);
  if ('code' in plan) return [];
  const findings: AmFinding[] = [];
  if (plan.emptyLayers.length > 0)
    findings.push({
      code: 'PRC_LAYER_MESH_MISMATCH',
      severity: 'error',
      message: `layer(s) ${plan.emptyLayers.join(', ')} hold no element (mesh coarser than the layer height ${am.layerHeight}): their strain is lost`,
      ids: [analysis.id],
    });
  const early = new Set<number>();
  const first = new Set(plan.layers[0]?.sets.flatMap((set) => set.elements));
  for (const block of mesh.blocks)
    for (const element of block.elements) {
      const id = element[0];
      const kept =
        block.entityId === am.plateEntityId || am.supportEntityIds.includes(block.entityId) || (id !== undefined && first.has(id));
      if (kept) for (const node of element.slice(1)) early.add(node);
    }
  const built = new Set(
    mesh.blocks.filter((block) => plan.buildParts.includes(block.entityId)).flatMap((block) => block.elements.flatMap((e) => e.slice(1))),
  );
  for (const [probeId, probe] of Object.entries(analysis.probes)) {
    if (!probe.quantity.startsWith('u_')) continue;
    const [node] = nearestNode(mesh, probeId, probe.point, lengthToAnalysis);
    if (node !== null && built.has(node) && !early.has(node))
      findings.push({
        code: 'PRC_PROBE_ON_BUILT_NODE',
        severity: 'warning',
        message: `probe '${probe.name}' (${probeId}) reads a node added with a later layer: its displacement starts from zero at its activation and under-reads the distortion; move it to the plate surface / part interface or clamp the plate`,
        ids: [probeId],
      });
  }
  return findings;
}

/**
 * PRC_LARGE_DEFLECTION (warning) when the largest displacement of any stored phase exceeds 1 % of the largest mesh extent.
 * @invariant empty without results
 */
export function amResultFindings(
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  lengthToAnalysis: number,
): AmFinding[] {
  const extent = ([1, 2, 3] as const).map((axis) => {
    const values = mesh.nodes.map((node) => node[axis]);
    return Math.max(...values) - Math.min(...values);
  });
  const size = Math.max(...extent);
  const worst = amLoadCases(analysis, mesh, results, lengthToAnalysis).reduce(
    (best, phase) => (phase.maxDisplacement.value > best.value ? { value: phase.maxDisplacement.value, name: phase.name } : best),
    { value: 0, name: '' },
  );
  return size > 0 && worst.value / size > LARGE_DEFLECTION_RATIO
    ? [
        {
          code: 'PRC_LARGE_DEFLECTION',
          severity: 'warning',
          message: `phase '${worst.name}' moves ${worst.value} (${((100 * worst.value) / size).toFixed(1)} % of the largest extent ${size}): beyond 1 % the layer activation drifts (measured 5 % at 3 %) and a release step can diverge`,
          ids: [analysis.id],
        },
      ]
    : [];
}

/**
 * The recorded summary of an AM case: the phases as load cases and the findings of the mesh and results.
 * @invariant findings are recomputed on every read from the artifacts, never stored apart from them
 */
export function amSummary(
  base: Pick<ResultsSummary, 'resultsHash' | 'inputHash' | 'solver' | 'solverVersion' | 'units'>,
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  lengthToAnalysis: number,
): ResultsSummary {
  const findings = [
    ...amMeshFindings(analysis, mesh, lengthToAnalysis),
    ...amResultFindings(analysis, mesh, results, lengthToAnalysis),
  ].map(({ code, severity, message }) => ({ code, severity, message }));
  return { ...base, loadCases: amLoadCases(analysis, mesh, results, lengthToAnalysis), am: { findings } };
}
