/** Thermal results summary (PHY-03 §5.5): extremes, per-BC heat flows, heat balance, probes, property range, field references. */

import type { FeMeshArtifact, FeResultsArtifact, ThermalResultsSummary, ThermalSetup } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import type { Vec3 } from '@core/model/vectors';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { systemToSi } from '@lib/thermalUnits';
import { evaluateProbes } from '../results/probes';
import { analysisLengthMetres } from '../shared/defaults';
import { isProblem, thermalCaseOf, type ThermalCase } from './access';
import { flowsAndBalance, nodal } from './heatBalance';
import { physicalConstantsOf, hasRadiation } from './constants';
import { caseTables } from './material';
import { indexMesh } from './meshGeometry';

type Step = FeResultsArtifact['steps'][number];
const ORIGIN: Vec3 = [0, 0, 0];

const emptySummary = (scale: ThermalSetup['temperatureScale']): ThermalResultsSummary => {
  const extreme = { value: 0, at: ORIGIN, entityId: '', timeS: 0 };
  return {
    temperatureScale: scale,
    times: [],
    maxT: extreme,
    minT: extreme,
    maxHeatFluxW_m2: { value: 0, at: ORIGIN, timeS: 0 },
    bcHeatFlowsW: [],
    heatBalance: { inW: 0, outW: 0, storedW: 0, residualRel: 0, timeS: 0 },
    probes: [],
    propertyRangeExceeded: [],
    fieldRefs: [],
  };
};

/** Tables out of range: property tables whose tabulated span the solved field leaves (CalculiX then holds the end values). */
function rangeExceeded(doc: CadDocument, found: ThermalCase, low: number, high: number): ThermalResultsSummary['propertyRangeExceeded'] {
  const out: ThermalResultsSummary['propertyRangeExceeded'][number][] = [];
  for (const { materialId, property, table } of caseTables(doc, found)) {
    if ('code' in table || table.range === null) continue;
    const [from, to] = table.range;
    if (low < from) out.push({ material: materialId, property, validRange: [from, to], reached: low });
    if (high > to) out.push({ material: materialId, property, validRange: [from, to], reached: high });
  }
  return out;
}

/**
 * ThermalResultsSummary of a heat_* results artifact over its mesh. Times: `[0]` for a steady case, else the CalculiX step times.
 * Heat flows are in W, positive into the part; the balance is evaluated at the LAST result time (stored power from the energy change since
 * the previous result time, or since the initial temperature for the first). Extremes keep the first node (lowest id) and earliest time.
 * @invariant deterministic and pure; every length in the result is in DOCUMENT units
 * @failure unknown / non-thermal analysis, or no NDTEMP in the results -> an all-zero summary with no times
 */
export function thermalResultsSummary(
  doc: CadDocument,
  analysisId: string,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
): ThermalResultsSummary {
  const found = thermalCaseOf(doc, analysisId);
  if (isProblem(found)) return emptySummary('degC');
  const { analysisCase, thermal } = found;
  const scale = thermal.temperatureScale;
  const steady = analysisCase.type === 'heat_steady';
  const steps = results.steps.filter((step) => Object.hasOwn(step.fields, 'NDTEMP'));
  if (steps.length === 0) return emptySummary(scale);
  const index = indexMesh(mesh);
  const unitSystem = analysisCase.unitSystem;
  const lengthToAnalysis = toMetres(doc, 1) / analysisLengthMetres(unitSystem);
  const timeOf = (step: Step): number => (steady ? 0 : step.time);

  let maxT = { value: Number.NEGATIVE_INFINITY, node: 0, timeS: 0 };
  let minT = { value: Number.POSITIVE_INFINITY, node: 0, timeS: 0 };
  let maxFlux = { value: 0, node: 0, timeS: 0 };
  for (const step of steps) {
    const temperature = nodal(step, 'NDTEMP');
    const flux = Object.hasOwn(step.fields, 'FLUX') ? step.fields['FLUX'] : undefined;
    for (const [node] of mesh.nodes) {
      const t = temperature(node);
      if (Number.isNaN(t)) continue;
      if (t > maxT.value) maxT = { value: t, node, timeS: timeOf(step) };
      if (t < minT.value) minT = { value: t, node, timeS: timeOf(step) };
      const components = flux !== undefined && Object.hasOwn(flux.values, String(node)) ? (flux.values[String(node)] ?? []) : [];
      const magnitude = Math.hypot(...components.slice(0, 3));
      if (magnitude > maxFlux.value) maxFlux = { value: magnitude, node, timeS: timeOf(step) };
    }
  }
  const located = (node: number): Vec3 => {
    const at = index.coordinates.get(node) ?? ORIGIN;
    return [at[0] / lengthToAnalysis, at[1] / lengthToAnalysis, at[2] / lengthToAnalysis];
  };
  const extreme = (e: typeof maxT): ThermalResultsSummary['maxT'] => ({
    value: e.value,
    at: located(e.node),
    entityId: index.entityOfNode.get(e.node) ?? '',
    timeS: e.timeS,
  });

  const { flows: bcHeatFlowsW, balance: heatBalance } = flowsAndBalance(doc, found, mesh, index, steps, timeOf);

  const probes: ThermalResultsSummary['probes'][number][] = [];
  for (const reading of evaluateProbes(analysisCase, mesh, results, lengthToAnalysis)) {
    if (reading.quantity !== 'temperature') continue;
    probes.push({
      probeId: reading.probeId,
      series: reading.values.filter((v) => v.value !== null).map((v) => [steady ? 0 : v.time, v.value ?? 0] as const),
    });
  }
  const resultsHash = sha256Hex(canonicalJson(results));
  return {
    temperatureScale: scale,
    times: steps.map(timeOf),
    maxT: extreme(maxT),
    minT: extreme(minT),
    maxHeatFluxW_m2: { value: systemToSi('flux', maxFlux.value, unitSystem), at: located(maxFlux.node), timeS: maxFlux.timeS },
    bcHeatFlowsW,
    heatBalance,
    probes,
    propertyRangeExceeded: rangeExceeded(doc, found, minT.value, maxT.value),
    fieldRefs: steps.map((step) => ({ resultsHash, step: step.step, timeS: timeOf(step) })),
    ...(hasRadiation(thermal) ? { physicalConstants: physicalConstantsOf(thermal) } : {}),
  };
}
