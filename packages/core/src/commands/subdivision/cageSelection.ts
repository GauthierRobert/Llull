/** Vertex selection of the cage edit commands: element references (ids or indices), world region, and soft-selection weights. */

import type { SubdivisionEntity, Vec3 } from '../../model/types';
import { type FalloffShape, graphDistances, softWeight } from '../../lib/falloff';
import { distance3 } from '../../lib/vec3';
import {
  type EdgeRef,
  type FaceRef,
  type RefProblem,
  type VertexRef,
  isRefProblem,
  resolveEdges,
  resolveFaces,
  resolveVertices,
} from '../../geometry/subd/elements';
import { type CageTopology, buildTopology } from '../../geometry/subd/topology';
import { worldOf } from './shared';

export interface SelectionInput {
  readonly vertexIndices?: readonly number[] | undefined;
  readonly vertices?: readonly VertexRef[] | undefined;
  readonly edges?: readonly EdgeRef[] | undefined;
  readonly faces?: readonly FaceRef[] | undefined;
  readonly region?: { readonly min: Vec3; readonly max: Vec3 } | undefined;
}

export interface Selection {
  /** `all`: nothing given, every vertex is selected. */
  readonly mode: 'all' | 'elements' | 'region';
  /** Selected vertex indices (elements mode). */
  readonly seeds: number[];
  /** Selected ids by kind, for the FeatureStep when an index was used (null when every reference was already an id). */
  readonly record: Record<string, unknown> | null;
  readonly topology: CageTopology;
}

/** A selection style conflict or a reference problem. */
export type SelectionProblem = RefProblem | { readonly code: 'DIR_SELECTION_CONFLICT'; readonly message: string; readonly path: string };

const unique = (items: readonly number[]): number[] => [...new Set(items)].sort((a, b) => a - b);

/** The vertices named by the element parameters (indices, vertex ids, edge endpoints, face corners), or the first problem. */
export function resolveSelection(entity: SubdivisionEntity, input: SelectionInput): Selection | SelectionProblem {
  const topology = buildTopology(entity.vertices.length, entity.faces);
  const styles = [input.vertexIndices, input.vertices, input.edges, input.faces, input.region].filter((x) => x !== undefined).length;
  if (input.region !== undefined && styles > 1)
    return {
      code: 'DIR_SELECTION_CONFLICT',
      message: 'give vertexIndices, vertices, edges, faces or region, not both',
      path: 'params.region',
    };
  if (input.region !== undefined) return { mode: 'region', seeds: [], record: null, topology };
  if (styles === 0) return { mode: 'all', seeds: [], record: null, topology };
  const seeds: number[] = [];
  const record: Record<string, unknown> = {};
  let indexed = false;
  const outOfRange = (input.vertexIndices ?? []).find((v) => v < 0 || v >= entity.vertices.length);
  if (outOfRange !== undefined)
    return {
      code: 'DIR_REF_LOST',
      message: `vertex ${outOfRange} is outside 0..${entity.vertices.length - 1}`,
      path: 'params.vertexIndices',
    };
  const named = resolveVertices(entity, [...(input.vertexIndices ?? []), ...(input.vertices ?? [])], 'params.vertices');
  if (isRefProblem(named)) return named;
  seeds.push(...named.items);
  if (input.vertexIndices !== undefined || named.byIndex) {
    indexed = true;
    record['vertices'] = named.ids;
    if (input.vertexIndices !== undefined) record['vertexIndices'] = undefined;
  }
  if (input.edges !== undefined) {
    const edges = resolveEdges(entity, input.edges, 'params.edges', topology);
    if (isRefProblem(edges)) return edges;
    for (const e of edges.items) seeds.push((topology.edges[e] as { a: number }).a, (topology.edges[e] as { b: number }).b);
    if (edges.byIndex) {
      indexed = true;
      record['edges'] = edges.ids;
    }
  }
  if (input.faces !== undefined) {
    const faces = resolveFaces(entity, input.faces, 'params.faces');
    if (isRefProblem(faces)) return faces;
    for (const f of faces.items) seeds.push(...(entity.faces[f] as ReadonlyArray<number>));
    if (faces.byIndex) {
      indexed = true;
      record['faces'] = faces.ids;
    }
  }
  return { mode: 'elements', seeds: unique(seeds), record: indexed ? record : null, topology };
}

/** World positions of the cage vertices rounded to 1e-6 (what the commands report, and what distances and pivots are measured on). */
export const worldVertices = (entity: SubdivisionEntity): Vec3[] => entity.vertices.map((p) => worldOf(p, entity));

/** Distance of every vertex to the selection: 0 for selected ones, Euclidean (to the nearest selected vertex or the region box) or along cage edges. */
export function selectionDistances(
  entity: SubdivisionEntity,
  selection: Selection,
  region: SelectionInput['region'],
  metric: 'euclidean' | 'topological',
): number[] {
  const world = worldVertices(entity);
  if (selection.mode === 'all') return world.map(() => 0);
  const outside = (p: Vec3): number => {
    const box = region as { min: Vec3; max: Vec3 };
    return Math.hypot(...p.map((value, axis) => Math.max((box.min[axis] as number) - value, 0, value - (box.max[axis] as number))));
  };
  if (selection.mode === 'region' && metric === 'euclidean') return world.map(outside);
  const seeds = selection.mode === 'region' ? world.flatMap((p, v) => (outside(p) <= 1e-9 ? [v] : [])) : selection.seeds;
  if (metric === 'topological') {
    const edges = selection.topology.edges.map(({ a, b }) => ({ a, b, length: distance3(world[a] as Vec3, world[b] as Vec3) }));
    return graphDistances(world.length, edges, seeds);
  }
  const seedPoints = seeds.map((v) => world[v] as Vec3);
  return world.map((p) => seedPoints.reduce((best, seed) => Math.min(best, distance3(p, seed)), Infinity));
}

/** Soft-selection weights from distances (1 on the selection, 0 beyond `radius`). */
export const selectionWeights = (distances: readonly number[], radius: number, shape: FalloffShape): number[] =>
  distances.map((d) => softWeight(d, radius, shape));
