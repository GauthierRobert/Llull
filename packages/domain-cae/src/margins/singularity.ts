/** Singularity screening of the margin table (05 OQ 8): nodes near point / edge loads and supports carry a mesh-dependent peak stress, not a margin. */

import type { AnalysisCase, FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { toMetres, toMm } from '@core/model/units';

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

/** A length in document units expressed in the length unit of the analysis unit system. */
function toAnalysisLength(doc: CadDocument, analysis: AnalysisCase, value: number): number {
  if (analysis.unitSystem === 'N-mm-t-s') return toMm(doc, value);
  return analysis.unitSystem === 'N-m-kg-s' ? toMetres(doc, value) : toMm(doc, value) / 25.4;
}

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

/** Mesh nodes within `radius` (analysis length unit, inclusive) of any source node; uniform grid so large meshes stay linear. */
function nodesWithin(mesh: FeMeshArtifact, sourceNodes: ReadonlySet<number>, radius: number): Set<number> {
  const excluded = new Set<number>();
  if (radius <= 0 || sourceNodes.size === 0) return excluded;
  const cell = (value: number): number => Math.floor(value / radius);
  const grid = new Map<string, [number, number, number][]>();
  const keyOf = (i: number, j: number, k: number): string => `${i},${j},${k}`;
  for (const [id, x, y, z] of mesh.nodes) {
    if (!sourceNodes.has(id)) continue;
    const key = keyOf(cell(x), cell(y), cell(z));
    grid.set(key, [...(grid.get(key) ?? []), [x, y, z]]);
  }
  for (const [id, x, y, z] of mesh.nodes) {
    const [ci, cj, ck] = [cell(x), cell(y), cell(z)];
    search: for (let i = ci - 1; i <= ci + 1; i++)
      for (let j = cj - 1; j <= cj + 1; j++)
        for (let k = ck - 1; k <= ck + 1; k++)
          for (const [sx, sy, sz] of grid.get(keyOf(i, j, k)) ?? [])
            if (Math.hypot(x - sx, y - sy, z - sz) <= radius) {
              excluded.add(id);
              break search;
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
  const radiusAnalysis = toAnalysisLength(doc, analysis, radiusDocument);
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
