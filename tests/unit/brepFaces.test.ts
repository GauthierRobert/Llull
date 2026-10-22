import { describe, it, expect, afterEach } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import type { FaceDetail, FaceGraph, FaceQueryPort } from '@core/geometry/kernelPorts';
import { fakeKernel } from '../helpers/fakeKernel';
import { xy } from '../helpers/xy';

afterEach(() => setGeometryKernel(null));

const DETAILS: FaceDetail[] = [
  { index: 0, surface: 'plane', area: 4, centroid: [1, 0, 0], normal: [1, 0, 0], samples: [[1, 0.5, 0.5]] },
  { index: 1, surface: 'cylinder', area: 6.28, centroid: [0, 0, 0], axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, radius: 1, samples: [] },
  { index: 2, surface: 'plane', area: 4, centroid: [-1, 0, 0], normal: [-1, 0, 0], samples: [] },
];
const GRAPH: FaceGraph = {
  faces: [],
  edgeFaces: [
    [0, 1],
    [1, 2],
  ],
  edgeConvexity: ['convex', 'concave'],
};

/** A kernel whose face-query port answers from fixed data and records the options it was called with. */
function withPort(overrides: Partial<FaceQueryPort> = {}): { kernel: GeometryKernel; sampleRequests: Array<number | undefined> } {
  const sampleRequests: Array<number | undefined> = [];
  const nothing = (): null => null;
  const port: FaceQueryPort = {
    faceDetails: (_shape, options) => {
      sampleRequests.push(options?.samples);
      return DETAILS;
    },
    faceContains: nothing,
    faceGraph: () => GRAPH,
    faceGeometry: nothing,
    projectOnFace: nothing,
    evaluateFace: nothing,
    tessellateFace: nothing,
    faceSamples: nothing,
    edgeSamples: nothing,
    edgeContinuity: nothing,
    distance: nothing,
    bspline: nothing,
    projectCurves: nothing,
    ...overrides,
  };
  return { kernel: Object.assign(fakeKernel(), { faceQuery: port }), sampleRequests };
}

function scene(): { doc: CadDocument; box: string; line: string } {
  const box = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
  const line = execute(box.document, 'draw_polyline', { points: xy(0, 0, 1, 0) });
  return { doc: line.document, box: box.affected[0]!, line: line.affected[0]! };
}

const run = (doc: CadDocument, params: unknown, kernel: GeometryKernel | null): ReturnType<typeof execute> =>
  execute(doc, 'inspect_faces', params, { ...defaultContext(), kernel });

describe('inspect_faces', () => {
  it('reports every face, document untouched, and is pure', () => {
    const { doc, box } = scene();
    const before = JSON.stringify(doc);
    const { kernel, sampleRequests } = withPort();
    const result = run(doc, { entityId: box }, kernel);
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.rejected).toBeUndefined();
    expect(result.data).toEqual({ entityId: box, faceCount: 3, faces: DETAILS });
    expect(sampleRequests).toEqual([0]);
    expect(result.summary).toContain(`'${box}' has 3 faces; 3 reported`);
    expect(result.summary).toContain('#0 plane area 4');
    expect(result.summary).toContain('radius 1');
  });

  it('filters faces, forwards the sample count and appends the graph', () => {
    const { doc, box } = scene();
    const { kernel, sampleRequests } = withPort();
    const result = run(doc, { entityId: box, faces: [2, 0], samples: 5, graph: true }, kernel);
    expect(sampleRequests).toEqual([5]);
    expect(result.data).toEqual({ entityId: box, faceCount: 3, faces: [DETAILS[0], DETAILS[2]], graph: GRAPH });
    expect(result.summary).toContain('1 convex, 1 concave, 0 smooth, 0 unknown');
  });

  it('summarises long face lists and leaves the rest to data', () => {
    const { doc, box } = scene();
    const many = Array.from({ length: 15 }, (_, index): FaceDetail => ({ ...DETAILS[0]!, index }));
    const { kernel } = withPort({ faceDetails: () => many });
    const result = run(doc, { entityId: box }, kernel);
    expect(result.summary).toContain('3 more in data.faces');
    expect((result.data as { faces: unknown[] }).faces).toHaveLength(15);
  });

  it.each([
    [
      'no kernel (refused by the registry before the command runs)',
      (): GeometryKernel | null => null,
      'CMD_KERNEL_UNAVAILABLE',
      /not available/,
    ],
    ['a kernel without a face-query port (Manifold)', () => fakeKernel(), 'KRN_NO_EXACT_KERNEL', /no exact kernel/],
    [
      'a solid the kernel cannot build',
      () => Object.assign(fakeKernel({ solid: null }), { faceQuery: withPort().kernel.faceQuery! }),
      'KRN_SHAPE_UNAVAILABLE',
      /could not build/,
    ],
    ['a kernel that cannot answer', () => withPort({ faceDetails: () => null }).kernel, 'KRN_FACE_QUERY_FAILED', /could not compute/],
    ['a graph the kernel cannot build', () => withPort({ faceGraph: () => null }).kernel, 'KRN_FACE_QUERY_FAILED', /face graph/],
  ])('refuses on %s', (_label, makeKernel, code, message) => {
    const { doc, box } = scene();
    const result = run(doc, { entityId: box, graph: true }, makeKernel());
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe(code);
    if (code !== 'CMD_KERNEL_UNAVAILABLE') expect(result.error?.ids).toEqual([box]);
    expect(result.summary).toMatch(message);
    expect(result.data).toBeUndefined();
  });

  it.each([
    ['a missing id', { entityId: 'ghost' }, 'ENTITY_NOT_FOUND', /not found/],
    ['a 2D entity', 'line', 'ENTITY_NOT_SOLID', /not a 3D solid/],
    ['a face index out of range', 'box', 'KRN_FACE_INDEX', /face index 7 out of range \(0-2\)/],
  ])('refuses %s', (_label, target, code, message) => {
    const { doc, box, line } = scene();
    const params = target === 'line' ? { entityId: line } : target === 'box' ? { entityId: box, faces: [1, 7] } : target;
    const result = run(doc, params, withPort().kernel);
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe(code);
    expect(result.summary).toMatch(message);
    expect(result.document).toBe(doc);
  });

  it('rejects invalid parameters before running', () => {
    const { doc, box } = scene();
    const result = run(doc, { entityId: box, samples: 1000 }, withPort().kernel);
    expect(result.summary).toMatch(/rejected: invalid params/);
    expect(result.affected).toEqual([]);
  });
});
