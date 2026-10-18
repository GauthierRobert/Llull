/** Summary of a nonlinear_static results artifact: per-step convergence bookkeeping, curve summaries, peak plastic strain (PHY-05 §3). */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact, NonlinearResultsSummary, ResultsSummary } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { significantNumber } from '@lib/compactNumber';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { maxOverNodes, magnitude, nodeCoordinates, nodeEntities, stepOfLoadCase, vonMises } from '../results/fields';
import { extractCurves } from './curves';

/** Increments, cutbacks and iterations of CalculiX step `number`: the `.sta` rows when the artifact has them, else the stored result sets. */
function stepProgress(
  results: FeResultsArtifact,
  number: number,
): { increments: number; cutbacks: number; iterations: number; lastTime: number } {
  const rows = (results.convergence ?? []).filter((row) => row.step === number);
  if (rows.length > 0)
    return {
      increments: rows.length,
      cutbacks: rows.reduce((sum, row) => sum + Math.max(0, row.attempts - 1), 0),
      iterations: rows.reduce((sum, row) => sum + row.iterations, 0),
      lastTime: Math.max(...rows.map((row) => row.totalTime)),
    };
  const stored = results.steps.filter((step) => step.step === number);
  return { increments: stored.length, cutbacks: 0, iterations: 0, lastTime: Math.max(0, ...stored.map((step) => step.time)) };
}

/** Largest equivalent plastic strain (FRD block `PE`) over the nodes of the last stored increment, with its position. */
function peakPeeq(mesh: FeMeshArtifact, results: FeResultsArtifact): NonlinearResultsSummary['maxPeeq'] {
  const last = results.steps.at(-1);
  const best = maxOverNodes(last?.fields['PE'], (values) => values[0] ?? Number.NaN);
  if (last === undefined || best === null) return undefined;
  const at: Vec3 = nodeCoordinates(mesh).get(best.node) ?? [0, 0, 0];
  return { value: best.value, at, step: last.step };
}

/**
 * `loadCases` (one per analysis step: max von Mises and max displacement of its last stored increment) and `nonlinear` of a nonlinear_static case.
 * @invariant deterministic and pure; curve hashes cover the numbers of the curve (time, load, displacement)
 */
export function nonlinearSummary(
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
): Pick<ResultsSummary, 'loadCases' | 'nonlinear'> {
  const nonlinear = analysis.nonlinear;
  const coordinates = nodeCoordinates(mesh);
  const entities = nodeEntities(mesh);
  const at = (node: number): Vec3 => coordinates.get(node) ?? [0, 0, 0];
  const loadCases: ResultsSummary['loadCases'][number][] = [];
  const steps: NonlinearResultsSummary['steps'][number][] = [];
  (nonlinear?.stepOrder ?? []).forEach((stepId, index) => {
    const step = nonlinear?.steps[stepId];
    const progress = stepProgress(results, index + 1);
    const lastLoadFactor = Math.min(1, Math.max(0, progress.lastTime - index));
    steps.push({
      stepId,
      increments: progress.increments,
      cutbacks: progress.cutbacks,
      iterations: progress.iterations,
      lastLoadFactor,
      completed: lastLoadFactor >= 1 - 1e-9,
    });
    const stored = stepOfLoadCase(results, index);
    const stress = maxOverNodes(stored?.fields.STRESS, vonMises);
    const displacement = maxOverNodes(stored?.fields.DISP, magnitude);
    if (step !== undefined && stress !== null && displacement !== null)
      loadCases.push({
        name: step.name,
        category: 'limit',
        maxVonMises: { value: stress.value, at: at(stress.node), entityId: entities.get(stress.node) ?? '' },
        maxDisplacement: { value: displacement.value, at: at(displacement.node) },
      });
  });
  const curves = extractCurves(analysis, results).map((curve) => {
    const peak = curve.load.reduce((best, value) => (Math.abs(value) > Math.abs(best) ? value : best), 0);
    return {
      probeId: curve.probeId,
      name: curve.name,
      points: curve.time.length,
      peakLoad: peak,
      dispRange: [Math.min(...curve.displacement), Math.max(...curve.displacement)] as const,
      curveHash: sha256Hex(canonicalJson({ time: curve.time, load: curve.load, displacement: curve.displacement })),
    };
  });
  const maxPeeq = peakPeeq(mesh, results);
  return {
    loadCases,
    nonlinear: {
      nlgeom: nonlinear?.nlgeom === true,
      completed: steps.length > 0 && steps.every((step) => step.completed),
      steps,
      curves,
      ...(maxPeeq !== undefined ? { maxPeeq } : {}),
    },
  };
}

/** `; nonlinear: 2 step(s), 64 increment(s), 3 cutback(s), completed; curve 'tip' 65 points, peak load 498.7, ...` for the record summary, else ''. */
export function nonlinearSummaryText(summary: ResultsSummary): string {
  const nonlinear = summary.nonlinear;
  if (nonlinear === undefined) return '';
  const increments = nonlinear.steps.reduce((sum, step) => sum + step.increments, 0);
  const cutbacks = nonlinear.steps.reduce((sum, step) => sum + step.cutbacks, 0);
  const curves = nonlinear.curves
    .map((curve) => `curve '${curve.name}' ${curve.points} points, peak load ${significantNumber(curve.peakLoad, 6)}`)
    .join('; ');
  const peeq = nonlinear.maxPeeq === undefined ? '' : `; max PEEQ ${significantNumber(nonlinear.maxPeeq.value, 4)}`;
  return `; nonlinear (nlgeom ${nonlinear.nlgeom}): ${nonlinear.steps.length} step(s), ${increments} increment(s), ${cutbacks} cutback(s), ${nonlinear.completed ? 'all steps completed' : 'NOT all steps reached their end'}${curves === '' ? '' : `; ${curves}`}${peeq}`;
}
