/** Singularity screening of the margin table (05 OQ 8): nodes near point / edge loads and supports carry a mesh-dependent peak stress, not a margin. */

import type { AnalysisCase, FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { toAnalysisLength } from '../decks/units';

interface SingularSource {
  readonly kind: 'load' | 'constraint';
  readonly id: string;
  /** Number of mesh nodes of the source. */
  readonly nodes: number;
}

export interface SingularScreen {
  readonly excluded: ReadonlySet<number>;
  readonly data: Record<string, unknown>;
}

const DEFAULT_RADIUS_SOURCE = 'llull default (05 OQ 8): 2 x mesh globalSize';

const hasFaces = (mesh: FeMeshArtifact, key: string): boolean => Object.hasOwn(mesh.faceSets, key) && (mesh.faceSets[key]?.length ?? 0) > 0;

/** Force / moment loads and constraints whose target resolved to no face of the mesh (point / edge targets) and have mesh nodes. */
function sourcesOf(analysis: AnalysisCase, mesh: FeMeshArtifact): { source: SingularSource; nodes: readonly number[] }[] {
  const found: { source: SingularSource; nodes: readonly number[] }[] = [];
  const add = (kind: SingularSource['kind'], id: string, key: string): void => {
    const nodes = Object.hasOwn(mesh.nodeSets, key) ? (mesh.nodeSets[key] ?? []) : [];
    if (nodes.length > 0 && !hasFaces(mesh, key)) found.push({ source: { kind, id, nodes: nodes.length }, nodes });
  };
  for (const id of analysis.loadOrder) {
    const kind = analysis.loads[id]?.kind;
    if (kind === 'force' || kind === 'moment') add('load', id, `L_${id}`);
  }
  for (const id of analysis.constraintOrder) {
    // A shell / plane-stress support on an edge is the normal way to clamp a 2D part (a side face of the solid maps to the shell edge):
    // its root carries the peak bending stress, which must stay in the margin, so it is not a singular source.
    const kind = analysis.parts[analysis.constraints[id]?.target.entityId ?? '']?.kind;
    if (kind !== 'shell' && kind !== 'plane_stress') add('constraint', id, `C_${id}`);
  }
  return found;
}

/** Mesh nodes within `radius` of any source node by direct comparison (sources x nodes). */
function nodesWithinDirect(mesh: FeMeshArtifact, sourceNodes: ReadonlySet<number>, radius: number): Set<number> {
  const sources = mesh.nodes.filter((node) => sourceNodes.has(node[0]));
  const excluded = new Set<number>();
  for (const [id, x, y, z] of mesh.nodes)
    if (sources.some((source) => Math.hypot(x - source[1], y - source[2], z - source[3]) <= radius)) excluded.add(id);
  return excluded;
}

/** Largest cell count the grid keys as one exact integer; beyond it (a radius tiny against the model) cells are keyed by text. */
const MAX_PACKED_CELLS = 2 ** 50;

/**
 * Mesh nodes within `radius` (analysis length unit, inclusive) of any source node; uniform grid so large meshes stay linear.
 * Cells are half a radius wide: two points of one cell are at most 0.87 radius apart, so a node sharing a cell with a source is in without a
 * distance test, and the other nodes look at the 5 x 5 x 5 cells around them.
 */
function nodesWithin(mesh: FeMeshArtifact, sourceNodes: ReadonlySet<number>, radius: number): Set<number> {
  const excluded = new Set<number>();
  if (radius <= 0 || sourceNodes.size === 0) return excluded;
  const cell = (value: number): number => Math.floor(value / (radius / 2));
  const low: [number, number, number] = [Infinity, Infinity, Infinity];
  const high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const [id, x, y, z] of mesh.nodes) {
    if (!sourceNodes.has(id)) continue;
    [cell(x), cell(y), cell(z)].forEach((index, axis) => {
      low[axis] = Math.min(low[axis] as number, index);
      high[axis] = Math.max(high[axis] as number, index);
    });
  }
  // Cell numbers past 2^50 no longer step by one (a radius tiny against the coordinates): compare with every source instead.
  const limit = MAX_PACKED_CELLS;
  const exact = mesh.nodes.every(([, x, y, z]) => Math.abs(cell(x)) < limit && Math.abs(cell(y)) < limit && Math.abs(cell(z)) < limit);
  if (!exact) return nodesWithinDirect(mesh, sourceNodes, radius);
  const [li, lj, lk] = low;
  const [ni, nj, nk] = [high[0] - li + 1, high[1] - lj + 1, high[2] - lk + 1];
  const packed = ni * nj * nk <= MAX_PACKED_CELLS;
  const keyOf = (i: number, j: number, k: number): number | string => (packed ? i - li + ni * (j - lj + nj * (k - lk)) : `${i},${j},${k}`);
  const inside = (i: number, j: number, k: number): boolean => i >= li && i < li + ni && j >= lj && j < lj + nj && k >= lk && k < lk + nk;
  const grid = new Map<number | string, number[]>();
  for (const [id, x, y, z] of mesh.nodes) {
    if (!sourceNodes.has(id)) continue;
    const key = keyOf(cell(x), cell(y), cell(z));
    const bucket = grid.get(key);
    if (bucket === undefined) grid.set(key, [x, y, z]);
    else bucket.push(x, y, z);
  }
  const near = (bucket: readonly number[], x: number, y: number, z: number): boolean => {
    for (let at = 0; at < bucket.length; at += 3) {
      const sx = bucket[at] as number;
      const sy = bucket[at + 1] as number;
      const sz = bucket[at + 2] as number;
      if (Math.hypot(x - sx, y - sy, z - sz) <= radius) return true;
    }
    return false;
  };
  for (const [id, x, y, z] of mesh.nodes) {
    const ci = cell(x);
    const cj = cell(y);
    const ck = cell(z);
    if (ci < li - 2 || ci > li + ni + 1 || cj < lj - 2 || cj > lj + nj + 1 || ck < lk - 2 || ck > lk + nk + 1) continue;
    if (inside(ci, cj, ck) && grid.has(keyOf(ci, cj, ck))) {
      excluded.add(id);
      continue;
    }
    search: for (let i = ci - 2; i <= ci + 2; i++)
      for (let j = cj - 2; j <= cj + 2; j++)
        for (let k = ck - 2; k <= ck + 2; k++) {
          if (!inside(i, j, k)) continue;
          const bucket = grid.get(keyOf(i, j, k));
          if (bucket !== undefined && near(bucket, x, y, z)) {
            excluded.add(id);
            break search;
          }
        }
  }
  return excluded;
}

/**
 * The singular nodes of a mesh: those within the radius of a point / edge load or support. Re-entrant sharp edges need geometry and are not screened.
 * @param radius override in document length units (0 = no exclusion); absent = 2 x the case mesh globalSize
 */
export function screenSingularities(
  doc: CadDocument,
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  override: { readonly radius: number; readonly note: string } | undefined,
): SingularScreen {
  const sources = sourcesOf(analysis, mesh);
  const radiusDocument = override?.radius ?? 2 * analysis.mesh.globalSize;
  const radiusAnalysis = toAnalysisLength(doc, analysis.unitSystem, radiusDocument);
  const excluded = nodesWithin(mesh, new Set(sources.flatMap((entry) => entry.nodes)), radiusAnalysis);
  const radius =
    override === undefined
      ? { value: radiusDocument, unit: doc.units, source: DEFAULT_RADIUS_SOURCE, defaulted: true }
      : { value: radiusDocument, unit: doc.units, source: 'set by the caller (singularityRadius)', defaulted: false };
  return {
    excluded,
    data: {
      performed: true,
      radius,
      ...(override === undefined ? {} : { singularityNote: override.note }),
      sources: sources.map((entry) => entry.source),
      excludedNodes: excluded.size,
      reentrantEdges: 'not screened (needs geometry: judge re-entrant corners and sharp edges yourself)',
    },
  };
}
