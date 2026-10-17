/** Result probes evaluated from a results artifact (the value at the NEAREST MESH NODE; temperature between nodes is interpolated in its element). */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact, ProbeQuantity } from '@core/model/analysis';
import { loadCasesOf } from '../decks/context';
import { lengthUnitName, stressUnitName } from '../decks/units';
import { magnitude, nodeCoordinates, stepOfLoadCase, vonMises, type ResultStep } from './fields';
import { systemToSi } from '@lib/thermalUnits';
import { locatePoint, type PointWeights } from './probeInterpolation';

interface ProbeValue {
  /** Load case name (static / thermo_static) or null for a time series (heat_*). */
  readonly loadCase: string | null;
  readonly step: number;
  /** seconds; 0 for heat_steady (steady state has no time, agrees with the thermal summary) */
  readonly time: number;
  /** null when the field was not written in that result set. */
  readonly value: number | null;
}

export interface ProbeReading {
  readonly probeId: string;
  readonly name: string;
  readonly quantity: ProbeQuantity;
  readonly unit: string;
  readonly nodeId: number | null;
  /** Distance probe point -> node, analysis length units. */
  readonly nodeDistance: number | null;
  readonly values: readonly ProbeValue[];
}

export const QUANTITY_FIELDS: Readonly<
  Record<ProbeQuantity, { readonly field: string; readonly scalar: (values: readonly number[]) => number }>
> = {
  temperature: { field: 'NDTEMP', scalar: (values) => values[0] ?? Number.NaN },
  heat_flux: { field: 'FLUX', scalar: magnitude },
  u_mag: { field: 'DISP', scalar: magnitude },
  u_x: { field: 'DISP', scalar: (values) => values[0] ?? Number.NaN },
  u_y: { field: 'DISP', scalar: (values) => values[1] ?? Number.NaN },
  u_z: { field: 'DISP', scalar: (values) => values[2] ?? Number.NaN },
  von_mises: { field: 'STRESS', scalar: vonMises },
  s_xx: { field: 'STRESS', scalar: (values) => values[0] ?? Number.NaN },
  s_yy: { field: 'STRESS', scalar: (values) => values[1] ?? Number.NaN },
  s_zz: { field: 'STRESS', scalar: (values) => values[2] ?? Number.NaN },
};

/** Factor from the solver's value of `quantity` to the value in quantityUnit (heat flux: system units -> W/m^2; others 1). */
export const quantityScale = (analysis: AnalysisCase, quantity: ProbeQuantity): number =>
  quantity === 'heat_flux' ? systemToSi('flux', 1, analysis.unitSystem) : 1;

export function quantityUnit(analysis: AnalysisCase, quantity: ProbeQuantity): string {
  if (quantity === 'temperature') return analysis.thermal?.temperatureScale ?? analysis.thermomech?.temperatureScale ?? 'degC';
  if (quantity === 'heat_flux') return 'W/m^2';
  return quantity.startsWith('u_') ? lengthUnitName(analysis.unitSystem) : stressUnitName(analysis.unitSystem);
}

function nearestNode(
  mesh: FeMeshArtifact,
  probeId: string,
  point: readonly [number, number, number],
  scale: number,
): [number | null, number | null] {
  const target = point.map((component) => component * scale);
  const coordinates = nodeCoordinates(mesh);
  const distanceTo = (id: number): number => {
    const at = coordinates.get(id);
    return at === undefined
      ? Number.POSITIVE_INFINITY
      : Math.hypot(at[0] - (target[0] ?? 0), at[1] - (target[1] ?? 0), at[2] - (target[2] ?? 0));
  };
  const key = `P_${probeId}`;
  const resolved = Object.hasOwn(mesh.nodeSets, key) ? mesh.nodeSets[key]?.[0] : undefined;
  if (resolved !== undefined && coordinates.has(resolved)) return [resolved, distanceTo(resolved)];
  let best: number | null = null;
  for (const id of coordinates.keys()) if (best === null || distanceTo(id) < distanceTo(best)) best = id;
  return [best, best === null ? null : distanceTo(best)];
}

function interpolated(at: PointWeights, field: ResultStep['fields'][string] | undefined): number {
  let sum = 0;
  for (const [node, weight] of at.nodes) {
    const value = field?.values[String(node)]?.[0];
    if (value === undefined) return Number.NaN;
    sum += weight * value;
  }
  return sum;
}

/**
 * Value of every probe of `analysis` at its node: the node the mesher resolved for the probe (`nodeSets.P_<id>`), else the nearest mesh node
 * to the probe point. Static and thermo_static give one value per load case (last increment); heat_* one per written result set.
 * @invariant nearest-node values, except a temperature probe between nodes, which is interpolated with the shape functions of the C3D4 / C3D10 element containing the point; nodal stresses are CalculiX's extrapolated and averaged values
 */
export function evaluateProbes(
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  lengthToAnalysis: number,
): ProbeReading[] {
  const heat = analysis.type === 'heat_steady' || analysis.type === 'heat_transient';
  const sets: { loadCase: string | null; step: ResultStep }[] = heat
    ? results.steps.map((step) => ({ loadCase: null, step }))
    : loadCasesOf(analysis).flatMap(({ name }, index) => {
        const step = stepOfLoadCase(results, index);
        return step === undefined ? [] : [{ loadCase: name, step }];
      });
  return Object.entries(analysis.probes).map(([probeId, probe]) => {
    const [nodeId, nodeDistance] = nearestNode(mesh, probeId, probe.point, lengthToAnalysis);
    const { field, scalar } = QUANTITY_FIELDS[probe.quantity];
    const inside =
      probe.quantity === 'temperature' && nodeDistance !== null && nodeDistance > 0
        ? locatePoint(mesh, [probe.point[0] * lengthToAnalysis, probe.point[1] * lengthToAnalysis, probe.point[2] * lengthToAnalysis])
        : null;
    return {
      probeId,
      name: probe.name,
      quantity: probe.quantity,
      unit: quantityUnit(analysis, probe.quantity),
      nodeId,
      nodeDistance,
      values: sets.map(({ loadCase, step }) => {
        const values = nodeId === null ? undefined : step.fields[field]?.values[String(nodeId)];
        const value =
          inside !== null
            ? interpolated(inside, step.fields[field])
            : values === undefined
              ? Number.NaN
              : scalar(values) * quantityScale(analysis, probe.quantity);
        return {
          loadCase,
          step: step.step,
          time: heat && analysis.type === 'heat_steady' ? 0 : step.time,
          value: Number.isFinite(value) ? value : null,
        };
      }),
    };
  });
}
