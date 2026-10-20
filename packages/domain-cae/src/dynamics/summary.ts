/**
 * `ResultsSummary.dynamics` (PHY-09 §3, TR-DYN-11/31/40/60): recomputed from the results artifact and the case set-up by the pure summariser
 * that record_fea_results and every trusted read use (05 §4.1). frequency_response: CalculiX steady-state peaks at the probes;
 * random_response: probe rms by modal superposition (randomResponse.ts) and the nodal maxima of the stored rms field.
 */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact, ProbeQuantity } from '@core/model/analysis';
import type { DynamicSummary, NodalRmsMax, ProbeDynamicResult } from '@core/model/structuralDynamics';
import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import { lengthUnitName, stressUnitName } from '../decks/units';
import { nodeCoordinates } from '../results/fields';
import { nearestNode } from '../results/probes';
import { analysisLengthMetres } from '../shared/defaults';
import { REVIEW_REASON } from './codes';
import { DEFAULT_PEAK_FACTOR } from './math/gaussian';
import { integrateAsd } from './math/psd';
import { GRID_CONVERGENCE_TOLERANCE, integrationGrid, meanSquare, modalForms, rmsOf, type ResponseComponent } from './math/randomResponse';
import { isPostProblem, modalPost, randomPost, type ModalPost, type RandomPost } from './randomSetup';
import { steadyStatePoints } from './results/modalData';

const COMPONENT = { x: 0, y: 1, z: 2 } as const;
const DISPLACEMENT = { u_x: 0, u_y: 1, u_z: 2, u_x_rel: 0, u_y_rel: 1, u_z_rel: 2 } as const;
const STRESS = { s_xx: 0, s_yy: 1, s_zz: 2 } as const;

const unitOf = (analysis: AnalysisCase, quantity: ProbeQuantity): string =>
  quantity.startsWith('a_') ? 'g' : quantity.startsWith('u_') ? lengthUnitName(analysis.unitSystem) : stressUnitName(analysis.unitSystem);

function probeNodes(
  doc: CadDocument,
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
): { id: string; name: string; quantity: ProbeQuantity; node: number | null }[] {
  const lengthToAnalysis = toMetres(doc, 1) / analysisLengthMetres(analysis.unitSystem);
  return Object.entries(analysis.probes).map(([id, probe]) => ({
    id,
    name: probe.name,
    quantity: probe.quantity,
    node: nearestNode(mesh, id, probe.point, lengthToAnalysis)[0],
  }));
}

function cumulativeMass(post: ModalPost): DynamicSummary['massParticipation'] {
  const index = new Map(post.tables.modes.map((row, i) => [row.mode, i]));
  const share = (direction: 0 | 1 | 2): number => {
    const total = post.tables.totalMass?.[direction] ?? 0;
    const kept = post.kept.reduce((sum, mode) => sum + (post.tables.effectiveMass[index.get(mode.mode) ?? -1]?.[direction] ?? 0), 0);
    return total > 0 ? kept / total : 0;
  };
  return { x: share(0), y: share(1), z: share(2) };
}

function frequencyProbes(
  doc: CadDocument,
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  post: ModalPost,
): ProbeDynamicResult[] {
  const points = steadyStatePoints(results);
  return probeNodes(doc, analysis, mesh).map(({ name, quantity, node }) => {
    const stress = quantity in STRESS;
    const component = stress ? STRESS[quantity as keyof typeof STRESS] : DISPLACEMENT[quantity as keyof typeof DISPLACEMENT];
    const field = stress ? 'STRESS' : 'DISP';
    const series = points.map((point) => {
      const re = node === null ? Number.NaN : (point.real[field]?.values[String(node)]?.[component] ?? Number.NaN);
      const im = node === null ? Number.NaN : (point.imaginary[field]?.values[String(node)]?.[component] ?? Number.NaN);
      return { fHz: point.fHz, magnitude: Math.hypot(re, im), phaseDeg: (Math.atan2(im, re) * 180) / Math.PI };
    });
    const peaks = series
      .filter(
        (entry, i) =>
          Number.isFinite(entry.magnitude) &&
          entry.magnitude > (series[i - 1]?.magnitude ?? -1) &&
          entry.magnitude > (series[i + 1]?.magnitude ?? -1),
      )
      .map((entry) => {
        const nearest = post.kept.reduce(
          (best, mode) => (Math.abs(mode.fHz - entry.fHz) < Math.abs(best.fHz - entry.fHz) ? mode : best),
          post.kept[0] ?? { mode: 0, fHz: 0 },
        );
        return { ...entry, mode: nearest.mode };
      });
    const top = peaks.reduce<(typeof peaks)[number] | null>(
      (best, peak) => (best === null || peak.magnitude > best.magnitude ? peak : best),
      null,
    );
    const q = top === null ? null : halfPowerQ(series, top);
    return { kind: 'frf', probe: name, quantity, unit: unitOf(analysis, quantity), peaks, ...(q !== null ? { qHalfPower: q } : {}) };
  });
}

/** Q = fPeak / (f2 - f1) with f1, f2 the half-power crossings (linear interpolation between output points), or null. */
function halfPowerQ(series: readonly { fHz: number; magnitude: number }[], peak: { fHz: number; magnitude: number }): number | null {
  const level = peak.magnitude / Math.SQRT2;
  const at = series.findIndex((entry) => entry.fHz === peak.fHz);
  const cross = (from: number, step: -1 | 1): number | null => {
    for (let i = from; i + step >= 0 && i + step < series.length; i += step) {
      const [a, b] = [series[i], series[i + step]];
      if (a !== undefined && b !== undefined && a.magnitude >= level && b.magnitude < level)
        return a.fHz + ((b.fHz - a.fHz) * (a.magnitude - level)) / (a.magnitude - b.magnitude);
    }
    return null;
  };
  const [f1, f2] = [cross(at, -1), cross(at, 1)];
  return f1 === null || f2 === null ? null : peak.fHz / (f2 - f1);
}

/** Response component of a random probe quantity: [source index in (ux, uy, uz, sxx .. szx), component definition]. */
function randomComponent(quantity: ProbeQuantity, post: RandomPost): { source: number; component: ResponseComponent } | null {
  if (quantity === 'a_x' || quantity === 'a_y' || quantity === 'a_z') {
    const axis = COMPONENT[quantity.slice(2) as 'x' | 'y' | 'z'];
    return { source: axis, component: { kind: 'absolute', unity: axis === post.direction, scale: 1 } };
  }
  if (quantity in DISPLACEMENT)
    return {
      source: DISPLACEMENT[quantity as keyof typeof DISPLACEMENT],
      component: { kind: 'relative', unity: false, scale: post.gravity },
    };
  if (quantity in STRESS)
    return { source: 3 + STRESS[quantity as keyof typeof STRESS], component: { kind: 'relative', unity: false, scale: post.gravity } };
  return null;
}

/** Modal coefficients c_j = modal value x G_j of a node and source (displacement 0..2, stress 3..8); NaN when a mode lacks the node. */
function coefficientsAt(post: RandomPost, node: number, source: number): Float64Array {
  return Float64Array.from(post.kept, (mode, j) => {
    const shape = post.shapes[mode.mode - 1];
    const values = source < 3 ? shape?.disp?.values[String(node)] : shape?.stress?.values[String(node)];
    return (values?.[source < 3 ? source : source - 3] ?? Number.NaN) * (post.gamma[j] ?? 0);
  });
}

function randomProbes(
  doc: CadDocument,
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  post: RandomPost,
  reasons: string[],
): ProbeDynamicResult[] {
  const forms = modalForms(post.basis, post.grid);
  const moments = modalForms(post.basis, post.grid, 2);
  const refined = modalForms(post.basis, integrationGrid(post.spectrum, post.band, post.kept, 2));
  const spectrumGrms = integrateAsd(post.spectrum, post.band).rms;
  return probeNodes(doc, analysis, mesh).flatMap(({ name, quantity, node }) => {
    const found = randomComponent(quantity, post);
    if (found === null || node === null) return [];
    const c = coefficientsAt(post, node, found.source);
    if (c.some((value) => !Number.isFinite(value))) {
      reasons.push(`probe '${name}': node ${node} has no ${found.source < 3 ? 'DISP' : 'STRESS'} in every kept mode`);
      return [];
    }
    const m0 = meanSquare(forms, c, found.component);
    const m2 = meanSquare(moments, c, found.component);
    const check = meanSquare(refined, c, found.component);
    if (Math.abs(check - m0) > GRID_CONVERGENCE_TOLERANCE * Math.abs(check))
      reasons.push(`DYN_PSD_GRID_NOT_CONVERGED probe '${name}': ${Math.abs(check - m0) / Math.abs(check)} relative change on halving`);
    const rms = rmsOf(m0, found.component);
    return [
      {
        kind: 'random' as const,
        probe: name,
        quantity,
        unit: unitOf(analysis, quantity),
        rms,
        peak: DEFAULT_PEAK_FACTOR.value * rms,
        peakFactor: DEFAULT_PEAK_FACTOR,
        zeroUpcrossingHz: m0 > 0 ? Math.sqrt(m2 / m0) : 0,
        spectrumGrms,
      },
    ];
  });
}

/** Largest value of every component of the stored nodal rms field (mesh node order: first node wins ties). */
function nodalMaxima(mesh: FeMeshArtifact, results: FeResultsArtifact): NodalRmsMax[] {
  const field = results.nodalRms;
  if (field === undefined) return [];
  const at = nodeCoordinates(mesh);
  return field.components.map((quantity, index) => {
    let best: { node: number; rms: number } | null = null;
    for (const [node] of mesh.nodes) {
      const value = field.values[String(node)]?.[index];
      if (value !== undefined && Number.isFinite(value) && (best === null || value > best.rms)) best = { node, rms: value };
    }
    return {
      quantity,
      rms: best?.rms ?? 0,
      unit: field.units[index] ?? '',
      node: best?.node ?? 0,
      at: at.get(best?.node ?? 0) ?? [0, 0, 0],
    };
  });
}

/** The dynamic summary of a solved frequency_response / random_response case (a problem gives an empty, unverified summary). */
export function dynamicResultsSummary(
  doc: CadDocument,
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
): DynamicSummary {
  const type: DynamicSummary['type'] = analysis.type === 'random_response' ? 'random_response' : 'frequency_response';
  const random = type === 'random_response';
  const post = random ? randomPost(doc, analysis, results) : modalPost(doc, analysis, results);
  const frequencyPointsHz = steadyStatePoints(results).map((point) => point.fHz);
  const common = {
    type,
    reviewRequired: true as const,
    reviewReason: REVIEW_REASON,
    ...(frequencyPointsHz.length > 0 ? { frequencyPointsHz } : {}),
  };
  if (isPostProblem(post))
    return {
      ...common,
      modesKept: 0,
      highestModeHz: 0,
      massParticipation: { x: 0, y: 0, z: 0 },
      dampingPerMode: [],
      probes: [],
      unverified: true,
      unverifiedReasons: [`${post.code}: ${post.message}`],
    };
  const reasons = [...post.unverifiedReasons];
  const probes = random
    ? randomProbes(doc, analysis, mesh, post as RandomPost, reasons)
    : frequencyProbes(doc, analysis, mesh, results, post);
  const field = results.nodalRms;
  return {
    ...common,
    modesKept: post.kept.length,
    highestModeHz: post.kept.at(-1)?.fHz ?? 0,
    massParticipation: cumulativeMass(post),
    dampingPerMode: post.kept.map((mode) => ({ mode: mode.mode, fHz: mode.fHz, zeta: mode.zeta })),
    probes,
    ...(random && field !== undefined
      ? {
          nodalMax: nodalMaxima(mesh, results),
          nodalField: { engine: field.engine, nodes: Object.keys(field.values).length, gridPoints: field.gridPoints },
        }
      : {}),
    unverified: reasons.length > 0,
    unverifiedReasons: reasons,
  };
}
