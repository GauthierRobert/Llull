/** Layer sets of an AM case (PHY-16 TR-PRC-20): build-part elements binned by centroid height along the build direction, measured from the plate top. */

import type { AnalysisCase, FeMeshArtifact } from '@core/model/analysis';
import type { AmBuildSettings } from '@core/model/am';
import type { DeckRefusal } from '../decks/context';
import { dot3 } from '@lib/vec3';

/** A deck holds two steps and one material per layer. */
export const MAX_LAYERS = 500;

/** Relative slack on a layer boundary: a centroid within this fraction of a layer of the boundary counts as above it. */
const BOUNDARY_SLACK = 1e-9;

interface AmLayer {
  /** 1-based geometric index: layer k covers (k - 1) t <= h < k t above the plate top. */
  readonly layer: number;
  /** Elements of this layer per build part (parts in `buildParts` order, only parts that hold elements). */
  readonly sets: readonly { readonly part: number; readonly elements: readonly number[] }[];
}

export interface AmLayerPlan {
  /** Build parts (parts of the case besides the plate and the supports), sorted by id. */
  readonly buildParts: readonly string[];
  /** Non-empty layers in build order; their position + 1 is the build index used by the steps and the expansion tables. */
  readonly layers: readonly AmLayer[];
  /** Geometric layers below the top one that hold no element. */
  readonly emptyLayers: readonly number[];
  /** Height of the plate top along the build direction (analysis length unit). */
  readonly plateTop: number;
}

/** The parts built layer by layer: every part of the case except the plate and the supports, sorted. */
export const buildPartsOf = (analysis: AnalysisCase, am: AmBuildSettings): string[] =>
  Object.keys(analysis.parts)
    .filter((id) => id !== am.plateEntityId && !am.supportEntityIds.includes(id))
    .sort();

const refuse = (code: string, message: string, ids: readonly string[]): DeckRefusal => ({ code, message, ids });

/**
 * Layer plan of `mesh`: `layerHeight` is document units, `lengthToAnalysis` converts to the mesh unit.
 * @invariant deterministic: elements keep mesh order; centroid = mean of the four corner nodes
 * @failure no plate elements / no build elements -> PRC_BUILD_SETUP_INVALID / PRC_PART_NOT_BUILT; more than MAX_LAYERS layers -> PRC_LAYERS_TOO_MANY
 */
export function amLayerPlan(
  analysis: AnalysisCase,
  am: AmBuildSettings,
  mesh: FeMeshArtifact,
  lengthToAnalysis: number,
): AmLayerPlan | DeckRefusal {
  const buildParts = buildPartsOf(analysis, am);
  if (buildParts.length === 0)
    return refuse('PRC_PART_NOT_BUILT', `analysis '${analysis.id}' has no part besides the plate and the supports`, [analysis.id]);
  const height = new Map<number, number>(mesh.nodes.map(([id, x, y, z]) => [id, dot3([x, y, z], am.buildDirection)]));
  const plateNodes = mesh.blocks
    .filter((block) => block.entityId === am.plateEntityId)
    .flatMap((block) => block.elements.flatMap((e) => e.slice(1)));
  if (plateNodes.length === 0)
    return refuse('PRC_BUILD_SETUP_INVALID', `the mesh has no element of the plate '${am.plateEntityId}'`, [am.plateEntityId]);
  const plateTop = Math.max(...plateNodes.map((node) => height.get(node) ?? -Infinity));
  const thickness = am.layerHeight * lengthToAnalysis;
  const byLayer = new Map<number, Map<number, number[]>>();
  for (const block of mesh.blocks) {
    const part = buildParts.indexOf(block.entityId);
    if (part < 0) continue;
    for (const element of block.elements) {
      const corners = element.slice(1, 5).map((node) => height.get(node) ?? plateTop);
      const above = corners.reduce((sum, h) => sum + h, 0) / corners.length - plateTop;
      const layer = Math.max(1, Math.floor(above / thickness + BOUNDARY_SLACK) + 1);
      const parts = byLayer.get(layer) ?? new Map<number, number[]>();
      parts.set(part, [...(parts.get(part) ?? []), element[0] ?? 0]);
      byLayer.set(layer, parts);
    }
  }
  const indices = [...byLayer.keys()].sort((a, b) => a - b);
  const top = indices.at(-1);
  if (top === undefined)
    return refuse('PRC_PART_NOT_BUILT', `the mesh has no element of the build part(s) ${buildParts.join(', ')}`, buildParts);
  if (indices.length > MAX_LAYERS)
    return refuse('PRC_LAYERS_TOO_MANY', `${indices.length} non-empty layers (layer height ${am.layerHeight}): at most ${MAX_LAYERS}`, [
      analysis.id,
    ]);
  return {
    buildParts,
    layers: indices.map((layer) => ({
      layer,
      sets: [...(byLayer.get(layer) ?? new Map<number, number[]>())]
        .sort((a, b) => a[0] - b[0])
        .map(([part, elements]) => ({ part, elements })),
    })),
    emptyLayers: Array.from({ length: top }, (_, i) => i + 1).filter((layer) => !byLayer.has(layer)),
    plateTop,
  };
}
