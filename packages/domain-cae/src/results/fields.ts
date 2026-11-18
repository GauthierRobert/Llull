/** Reads of a results artifact shared by the summaries and the report: load-case steps, node lookups, derived scalars. */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { memoByObject } from '@lib/memoByObject';
import { isTransientCase } from '../thermal/access';

export type ResultStep = FeResultsArtifact['steps'][number];

/**
 * The result set of load case `index` (0-based): the last written increment of CalculiX step `index + 1`.
 * For a transient coupled case (`analysis` given) it is the increment of the LAST solver step with STRESS (the coupled one, after any
 * pre-heating step) with the largest von Mises over its field (first one wins ties): the peak over time, which is what margins must use.
 */
export function stepOfLoadCase(results: FeResultsArtifact, index: number, analysis?: AnalysisCase): ResultStep | undefined {
  if (analysis === undefined || analysis.type !== 'coupled_temperature_displacement' || !isTransientCase(analysis))
    return results.steps.filter((step) => step.step === index + 1).at(-1);
  const last = results.steps.reduce((max, step) => (step.fields['STRESS'] === undefined ? max : Math.max(max, step.step)), 0);
  let best: { step: ResultStep; value: number } | undefined;
  for (const step of results.steps) {
    if (step.step !== last) continue;
    const value = maxOverNodes(step.fields['STRESS'], vonMises)?.value;
    if (value !== undefined && (best === undefined || value > best.value)) best = { step, value };
  }
  return best?.step;
}

/** Position of each node, built once per mesh artifact (shared: read-only). */
export const nodeCoordinates: (mesh: FeMeshArtifact) => ReadonlyMap<number, Vec3> = memoByObject(
  (mesh: FeMeshArtifact): ReadonlyMap<number, Vec3> => {
    const positions = new Map<number, Vec3>();
    for (const node of mesh.nodes) positions.set(node[0], [node[1], node[2], node[3]]);
    return positions;
  },
);

/** Entity owning each node (the first block that lists it), built once per mesh artifact (shared: read-only). */
export const nodeEntities: (mesh: FeMeshArtifact) => ReadonlyMap<number, string> = memoByObject(
  (mesh: FeMeshArtifact): ReadonlyMap<number, string> => {
    const owner = new Map<number, string>();
    for (const block of mesh.blocks)
      for (const element of block.elements)
        for (let at = 1; at < element.length; at += 1) {
          const node = element[at] as number;
          if (!owner.has(node)) owner.set(node, block.entityId);
        }
    return owner;
  },
);

/** von Mises equivalent of [Sxx, Syy, Szz, Sxy, Syz, Szx]. */
export function vonMises(stress: readonly number[]): number {
  const [xx = 0, yy = 0, zz = 0, xy = 0, yz = 0, zx = 0] = stress;
  return Math.sqrt(0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) + 3 * (xy ** 2 + yz ** 2 + zx ** 2));
}

type NodalValues = { readonly values: Readonly<Record<string, readonly number[]>> };
type NodalScalar = (values: readonly number[]) => number;
type NodalMaximum = { readonly node: number; readonly value: number } | null;

const component = (values: readonly number[], index: number): number => values[index] ?? 0;

export const magnitude = (values: readonly number[]): number =>
  Math.hypot(component(values, 0), component(values, 1), component(values, 2));

function scanMaximum(field: NodalValues, scalar: NodalScalar): NodalMaximum {
  let best: { node: number; value: number } | null = null;
  const values = field.values;
  for (const id in values) {
    const value = scalar(values[id] as readonly number[]);
    if (Number.isFinite(value) && (best === null || value > best.value)) best = { node: Number(id), value };
  }
  return best;
}

/** The maxima every summary asks for, kept per field of a stored (immutable) results artifact. */
const knownMaxima: ReadonlyMap<NodalScalar, (field: NodalValues) => NodalMaximum> = new Map<
  NodalScalar,
  (field: NodalValues) => NodalMaximum
>([
  [vonMises, memoByObject((field: NodalValues) => scanMaximum(field, vonMises))],
  [magnitude, memoByObject((field: NodalValues) => scanMaximum(field, magnitude))],
]);

/** Largest scalar over the nodes of a field (first node wins ties); null for an empty / missing field. */
export function maxOverNodes(field: NodalValues | undefined, scalar: NodalScalar): NodalMaximum {
  if (field === undefined) return null;
  return (knownMaxima.get(scalar) ?? ((values: NodalValues) => scanMaximum(values, scalar)))(field);
}
