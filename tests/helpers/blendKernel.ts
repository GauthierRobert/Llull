/** A scripted exact kernel for the blend command tests: one topology, scripted face queries, every evaluated recipe recorded. */
import type { GeometryKernel, ShapeTopology } from '@core/geometry/kernel';
import type { BlendSection, FaceGraph } from '@core/geometry/kernelPorts';
import { handleOf } from '@core/geometry/shapeKernel';
import type { ShapeRecipe } from '@core/model/types';
import { TETRA } from './fakeKernel';

/** Entity id the scripted topology names its faces after (`add_box` in an empty document). */
export const SOURCE = 'box-1.1';

export const edgeOf = (index: number, extra: Partial<ShapeTopology['edges'][number]> = {}): ShapeTopology['edges'][number] => ({
  index,
  name: `e(${SOURCE}:a${index}|${SOURCE}:b${index})`,
  curve: 'line',
  length: 20,
  start: [0, index, 0],
  end: [20, index, 0],
  mid: [10, index, 0],
  seam: false,
  degenerate: false,
  ...extra,
});

export const TOPOLOGY: ShapeTopology = {
  solids: 1,
  faces: [
    { index: 0, name: `${SOURCE}:x+`, surface: 'plane', area: 4, normal: [1, 0, 0] },
    { index: 1, name: `${SOURCE}:z+`, surface: 'plane', area: 4, normal: [0, 0, 1] },
    { index: 2, name: `${SOURCE}:side`, surface: 'cylinder', area: 4 },
    { index: 3, name: `${SOURCE}:flat`, surface: 'plane', area: 4, normal: [1, 0, 0] },
  ],
  edges: [
    edgeOf(0),
    edgeOf(1, { curve: 'circle', length: 31.4, start: [5, 0, 0], end: [5, 0, 0] }),
    edgeOf(2),
    edgeOf(3, { seam: true }),
    edgeOf(4),
  ],
  vertices: 8,
  volume: 1000,
};

// edge 0: two planes; 1: plane against the cylinder (a rim); 2: plane against the cylinder; 3: seam; 4: two coplanar planes
const GRAPH = { faces: [], edgeFaces: [[0, 1], [1, 2], [0, 2], [2], [0, 3]], edgeConvexity: [] } as unknown as FaceGraph;

export interface BlendScript {
  /** g1 (angle between the outward normals) at `t` of an edge; default a right angle. */
  g1?: (edge: number, t: number) => number;
  /** g0 (gap between the two faces) at `t` of an edge; default 0. */
  g0?: (edge: number, t: number) => number;
  noContinuity?: boolean;
  noGraph?: boolean;
  noNames?: boolean;
  noTopology?: boolean;
  noFaceQuery?: boolean;
  /** Distance of the probed point to each face (default: face index). */
  distance?: (face: number, point: readonly [number, number, number]) => number;
  noProject?: boolean;
  /** Topology override (checks that need blend faces). */
  topology?: ShapeTopology;
  graph?: FaceGraph;
  /** Sections of a blend face (default: not offered by the kernel). */
  sections?: ((face: number, count: number) => readonly BlendSection[] | null) | null | undefined;
  /** The face nearest to a point and how far it is (`faceQuery.distance`); default: face = round(x) clamped to the topology, distance 0; null = the kernel cannot answer. */
  faceAt?: ((point: readonly [number, number, number]) => { readonly face: number; readonly distance: number }) | null | undefined;
  /** Points of `edgeSamples` (default: along +x from the edge start). */
  edgePoint?: (edge: number, t: number) => [number, number, number];
}

export type ScriptedKernel = GeometryKernel & { recipes: ShapeRecipe[] };

export function scriptedKernel(script: BlendScript = {}): ScriptedKernel {
  const recipes: ShapeRecipe[] = [];
  const base = script.topology ?? TOPOLOGY;
  const topology: ShapeTopology =
    script.noNames === true
      ? { ...base, faces: base.faces.map(({ name: _name, ...face }) => face), edges: base.edges.map(({ name: _name, ...edge }) => edge) }
      : base;
  const faceQuery = {
    faceGraph: () => (script.noGraph === true ? null : (script.graph ?? GRAPH)),
    edgeContinuity: (_shape: unknown, edge: number, count: number) =>
      script.noContinuity === true
        ? null
        : Array.from({ length: count }, (_, k) => ({
            t: k / (count - 1),
            point: [k, 0, 0] as [number, number, number],
            g0: (script.g0 ?? (() => 0))(edge, k / (count - 1)),
            g1: (script.g1 ?? (() => Math.PI / 2))(edge, k / (count - 1)),
            normalCurvature: [0, 0] as [number, number],
          })),
    edgeSamples: (_shape: unknown, edge: number, count: number) =>
      Array.from({ length: count }, (_, k) => ({
        t: k / (count - 1),
        point: (script.edgePoint ?? ((_e, t) => [20 * t, 0, 0]))(edge, k / (count - 1)),
        tangent: [1, 0, 0],
      })),
    distance: (_shape: unknown, points: ReadonlyArray<readonly [number, number, number]>) =>
      script.faceAt === null
        ? null
        : points.map((point) =>
            (script.faceAt ?? ((p) => ({ face: Math.min(Math.max(Math.round(p[0]), 0), base.faces.length - 1), distance: 0 })))(point),
          ),
    projectOnFace: (_shape: unknown, face: number, points: ReadonlyArray<readonly [number, number, number]>) =>
      script.noProject === true ? null : points.map((point) => ({ distance: (script.distance ?? ((f) => f))(face, point) })),
    ...(script.sections === null || script.sections === undefined
      ? {}
      : {
          blendSections: (_shape: unknown, face: number, _a: number, _b: number, count: number) => script.sections?.(face, count) ?? null,
        }),
  };
  return {
    name: 'scripted',
    recipes,
    supports: () => true,
    evaluate: (recipe) => {
      recipes.push(recipe);
      return handleOf(recipe);
    },
    tessellate: () => TETRA,
    topology: () => (script.noTopology === true ? null : topology),
    exportStep: () => null,
    ...(script.noFaceQuery === true ? {} : { faceQuery: faceQuery as unknown as NonNullable<GeometryKernel['faceQuery']> }),
  };
}
