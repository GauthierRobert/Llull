/** A scripted exact kernel with two profiled blend faces meeting a top face (contacts: edges 0 and 1) and each other (junction: edge 2), for the blend review tests. */
import type { ShapeTopology } from '@core/geometry/kernel';
import type { FaceGraph } from '@core/geometry/kernelPorts';
import { edgeOf, scriptedKernel, type ScriptedKernel } from './blendKernel';

const faces: ShapeTopology['faces'] = [
  { index: 0, name: 'T', surface: 'plane', area: 100, normal: [0, 0, 1] },
  { index: 1, name: 'W1', surface: 'plane', area: 10, normal: [1, 0, 0] },
  { index: 2, name: 'W2', surface: 'plane', area: 10, normal: [1, 0, 0] },
  { index: 3, name: 'blend(e(T|W1))', surface: 'bspline', area: 4 },
  { index: 4, name: 'blend(e(T|W2))', surface: 'bspline', area: 4 },
];
export const CHAIN_TOPOLOGY: ShapeTopology = {
  solids: 1,
  faces,
  edges: [
    edgeOf(0, { name: 'e(T|W1)' }),
    edgeOf(1, { name: 'e(T|W2)' }),
    edgeOf(2, { name: 'e(blend(e(T|W1))|blend(e(T|W2)))' }),
    edgeOf(3, { name: 'e(W1|W2)' }),
  ],
  vertices: 8,
  volume: 1000,
};
// edge 3 is the sharp edge between the walls (it carries no angle)
export const CHAIN_GRAPH = {
  faces: [],
  edgeFaces: [
    [3, 0],
    [4, 0],
    [3, 4],
    [1, 2],
  ],
  edgeConvexity: [],
} as unknown as FaceGraph;

/** The kernel; `g1(edge, t)` is the angle between the outward normals read on a contact or junction. */
export const chainKernel = (g1: (edge: number, t: number) => number): ScriptedKernel =>
  scriptedKernel({ topology: CHAIN_TOPOLOGY, graph: CHAIN_GRAPH, g1: (edge, t) => (edge === 3 ? 0 : g1(edge, t)) });

/** The arguments of the fillet_edge that makes the two profiled blends. */
export const CHAIN_FILLET = {
  edges: [
    { index: 0, size: 1 },
    { index: 1, size: 1 },
  ],
  profile: { type: 'conic', rho: 0.5 },
} as const;
