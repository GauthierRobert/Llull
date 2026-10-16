/** Reads of a results artifact shared by the summaries and the report: load-case steps, node lookups, derived scalars. */

import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';

export type ResultStep = FeResultsArtifact['steps'][number];

/** The result set of load case `index` (0-based): the last written increment of CalculiX step `index + 1`. */
export function stepOfLoadCase(results: FeResultsArtifact, index: number): ResultStep | undefined {
  return results.steps.filter((step) => step.step === index + 1).at(-1);
}

export const nodeCoordinates = (mesh: FeMeshArtifact): Map<number, Vec3> =>
  new Map(mesh.nodes.map((node): [number, Vec3] => [node[0], [node[1], node[2], node[3]]]));

/** Entity owning each node (the first block that lists it). */
export function nodeEntities(mesh: FeMeshArtifact): Map<number, string> {
  const owner = new Map<number, string>();
  for (const block of mesh.blocks)
    for (const element of block.elements) for (const node of element.slice(1)) if (!owner.has(node)) owner.set(node, block.entityId);
  return owner;
}

/** von Mises equivalent of [Sxx, Syy, Szz, Sxy, Syz, Szx]. */
export function vonMises(stress: readonly number[]): number {
  const [xx = 0, yy = 0, zz = 0, xy = 0, yz = 0, zx = 0] = stress;
  return Math.sqrt(0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) + 3 * (xy ** 2 + yz ** 2 + zx ** 2));
}

/** Largest scalar over the nodes of a field (first node wins ties); null for an empty / missing field. */
export function maxOverNodes(
  field: { readonly values: Readonly<Record<string, readonly number[]>> } | undefined,
  scalar: (values: readonly number[]) => number,
): { readonly node: number; readonly value: number } | null {
  let best: { node: number; value: number } | null = null;
  for (const [id, values] of Object.entries(field?.values ?? {})) {
    const value = scalar(values);
    if (Number.isFinite(value) && (best === null || value > best.value)) best = { node: Number(id), value };
  }
  return best;
}

export const magnitude = (values: readonly number[]): number => Math.hypot(...values.slice(0, 3));
