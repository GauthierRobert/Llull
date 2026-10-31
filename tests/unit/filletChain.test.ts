/**
 * fillet_edge `chain` (TECHNICAL_SPEC 13.27 Left): the selected edges are ONE tangent chain and radius -> radiusEnd (or chain.law) runs over its total arc length, each edge getting the piece of the law
 * on it (the same layout as fillet_faces). A scripted kernel serves three collinear edges 0..4, 4..10 and 10..20 along x (lengths 4, 6, 10), a bent continuation, a separate edge and a two-edge loop.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { type MeshSolidEntity, createEmptyDocument } from '@core/model/types';
import type { EdgeRadius, Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel, type ShapeTopology } from '@core/geometry/kernel';
import type { FaceGraph } from '@core/geometry/kernelPorts';
import { kernelFromOps, type FaceQueryOps } from '@core/geometry/shapeKernel';
import { TETRA } from '../helpers/fakeKernel';
import { expectPure } from '../helpers/expectNoOp';

afterEach(() => setGeometryKernel(null));

interface Scripted {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly tangent: Vec3;
}

const X: Vec3 = [1, 0, 0];
const LINE: Scripted[] = [
  { from: [0, 0, 0], to: [4, 0, 0], tangent: X },
  { from: [4, 0, 0], to: [10, 0, 0], tangent: X },
  { from: [10, 0, 0], to: [20, 0, 0], tangent: X },
  // a bent continuation of edge 2 (90 degrees) and an edge that touches nothing
  { from: [20, 0, 0], to: [20, 5, 0], tangent: [0, 1, 0] },
  { from: [0, 30, 0], to: [5, 30, 0], tangent: X },
];
/** Two edges that close on themselves: out along x and back. */
const LOOP: Scripted[] = [
  { from: [0, 0, 0], to: [4, 0, 0], tangent: X },
  { from: [4, 0, 0], to: [0, 0, 0], tangent: X },
];

const length = (edge: Scripted): number => Math.hypot(edge.to[0] - edge.from[0], edge.to[1] - edge.from[1]);

function scripted(edges: Scripted[]): { kernel: ReturnType<typeof kernelFromOps>; laws: EdgeRadius[][] } {
  const topology: ShapeTopology = {
    solids: 1,
    faces: [
      { index: 0, surface: 'plane', area: 4, normal: [0, 0, 1] },
      { index: 1, surface: 'plane', area: 4, normal: [0, 1, 0] },
    ],
    edges: edges.map((edge, index) => ({
      index,
      curve: 'line',
      length: length(edge),
      start: edge.from,
      end: edge.to,
      mid: [(edge.from[0] + edge.to[0]) / 2, (edge.from[1] + edge.to[1]) / 2, 0],
      seam: false,
      degenerate: false,
    })),
    vertices: 8,
    volume: 8,
  };
  const graph = { faces: [], edgeFaces: edges.map(() => [0, 1]), edgeConvexity: edges.map(() => 'convex') } as unknown as FaceGraph;
  const laws: EdgeRadius[][] = [];
  const shape = { mesh: TETRA };
  const kernel = kernelFromOps<typeof shape>({
    solid: () => shape,
    boolean: () => null,
    fillet: () => ({ mesh: TETRA }),
    filletEach: (_s: typeof shape, _edges: readonly number[], each: readonly EdgeRadius[]) => {
      laws.push([...each]);
      return { mesh: TETRA };
    },
    blend: () => null,
    chamfer: () => null,
    shell: () => null,
    place: (s) => s,
    scale: (s) => s,
    tessellate: (s) => s.mesh,
    topology: () => topology,
    exportStep: () => null,
    release: () => undefined,
    faceQuery: {
      faceGraph: () => graph,
      edgeSamples: (_s: typeof shape, edge: number) => {
        const e = edges[edge] as Scripted;
        return [
          { t: 0, s: 0, point: e.from, tangent: e.tangent },
          { t: 1, s: length(e), point: e.to, tangent: e.tangent },
        ];
      },
    } as unknown as FaceQueryOps<typeof shape>,
  });
  return { kernel, laws };
}

const box = (): { doc: ReturnType<typeof createEmptyDocument>; id: string } => {
  const made = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
  return { doc: made.document, id: made.affected[0] as string };
};

const run = (
  kernel: ReturnType<typeof scripted>['kernel'],
  doc: ReturnType<typeof createEmptyDocument>,
  params: unknown,
): ReturnType<typeof execute> => execute(doc, 'fillet_edge', params, { ...defaultContext(), kernel });

describe('fillet_edge chain', () => {
  it('radius -> radiusEnd runs over the total arc length (20): each edge gets the straight piece between the values at its two ends', () => {
    const { kernel, laws } = scripted(LINE);
    const { doc, id } = box();
    const params = { id, edgeIndices: [2, 0, 1], radius: 1, radiusEnd: 3, chain: {} };
    const result = run(kernel, doc, params);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toEqual(result.affected);
    const mesh = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    expect(mesh.brep).toMatchObject({ op: 'fillet', edges: [0, 1, 2] });
    expect(laws[0]).toEqual([
      { size: 1, sizeEnd: 1.4, interpolation: 'linear' },
      { size: 1.4, sizeEnd: 2, interpolation: 'linear' },
      { size: 2, sizeEnd: 3, interpolation: 'linear' },
    ]);
    expectPure(doc, () => run(kernel, doc, params));
  });

  it('startNear picks the end where the law starts: from x = 20 the law runs the other way, each edge law given in the edge own direction', () => {
    const { kernel, laws } = scripted(LINE);
    const { doc, id } = box();
    const result = run(kernel, doc, { id, edgeIndices: [0, 1, 2], radius: 1, radiusEnd: 3, chain: { startNear: [19, 0, 0] } });
    expect(result.rejected, result.summary).toBeUndefined();
    // the walk is edge 2, 1, 0: edge 2 (x 10..20) runs 2 at x = 10 down to 1 at x = 20; edge 0 (x 0..4) is the last, 3 at x = 0 and 2.6 at x = 4
    expect(laws[0]?.[0]).toMatchObject({ size: 2, sizeEnd: 1 });
    expect(laws[0]?.[2]).toMatchObject({ size: 3, sizeEnd: 2.6 });
  });

  it('chain.law is an expression of t over the chain: stations per edge at its arc fractions, joined by straight pieces', () => {
    const { kernel, laws } = scripted(LINE);
    const { doc, id } = box();
    const near: Vec3[] = [
      [2, 0, 0],
      [7, 0, 0],
      [15, 0, 0],
    ];
    const result = run(kernel, doc, { id, edgesNear: near, chain: { law: { expression: '1 + 2*t', samples: 5 } } });
    expect(result.rejected, result.summary).toBeUndefined();
    const first = laws[0]?.[0];
    expect(first).toMatchObject({ size: 1, sizeEnd: 1.4, interpolation: 'linear' });
    expect(first?.sizes).toHaveLength(3);
    expect(first?.sizes?.[1]).toMatchObject({ t: 0.5, size: 1.2 });
    expect(laws[0]?.[2]).toMatchObject({ size: 2, sizeEnd: 3 });
  });

  it('refused by name: edges that are not one tangent chain (a 90 degree bend, two separate edges) are BLD_CHAIN_UNSUPPORTED at the chain path, the document unchanged', () => {
    const { kernel } = scripted(LINE);
    const { doc, id } = box();
    const bend = run(kernel, doc, { id, edgeIndices: [2, 3], radius: 1, radiusEnd: 2, chain: {} });
    expect(bend.rejected).toBe(true);
    expect(bend.error?.code).toBe('BLD_CHAIN_UNSUPPORTED');
    expect(bend.error?.paths).toEqual(['chain']);
    expect(bend.summary).toContain('not one tangent chain');
    expect(bend.document).toBe(doc);
    expect(bend.affected).toEqual([]);
    const apart = run(kernel, doc, { id, edgeIndices: [0, 4], radius: 1, radiusEnd: 2, chain: {} });
    expect(apart.error?.code).toBe('BLD_CHAIN_UNSUPPORTED');
    expect(apart.summary).toContain('selected edges');
    expect(apart.summary).toContain('2 separate pieces');
  });

  it('a law that is not > 0 along the chain is BLD_LAW_INVALID at the chain path; the unusable combinations are no-ops with the reason', () => {
    const { kernel } = scripted(LINE);
    const { doc, id } = box();
    const negative = run(kernel, doc, { id, edgeIndices: [0, 1, 2], chain: { law: { expression: '0.5 - t' } } });
    expect(negative.error?.code).toBe('BLD_LAW_INVALID');
    expect(negative.error?.paths).toEqual(['chain.law.expression']);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ edgeIndices: [0, 1], radius: 1, chain: { law: { expression: '1 + t' } } }, 'replaces radius'],
      [{ radius: 1, radiusEnd: 2, chain: {} }, 'chain needs the edges'],
      [{ edgeIndices: [0, 1], chain: {} }, 'chain needs radius'],
      [{ edges: [{ index: 0, size: 1 }], chain: {} }, 'not edges[]'],
    ];
    for (const [params, reason] of cases) {
      const result = run(kernel, doc, { id, ...params });
      expect(result.document, reason).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.summary).toContain(reason);
    }
  });

  it('a closed loop takes a constant size, refuses a radiusEnd that differs (with the hint to leave it out) and startNear', () => {
    const { kernel } = scripted(LOOP);
    const { doc, id } = box();
    const open = run(kernel, doc, { id, edgeIndices: [0, 1], radius: 1, radiusEnd: 2, chain: {} });
    expect(open.error?.code).toBe('BLD_LAW_NOT_PERIODIC');
    expect(open.error?.paths).toEqual(['radiusEnd']);
    expect(open.summary).toContain('leave radiusEnd out');
    const lone = run(kernel, doc, { id, edgeIndices: [0, 1], radius: 1, chain: { startNear: [0, 0, 0] } });
    expect(lone.error?.paths).toEqual(['chain.startNear']);
    const closed = run(kernel, doc, { id, edgeIndices: [0, 1], radius: 1, chain: {} });
    expect(closed.rejected, closed.summary).toBeUndefined();
  });
});
