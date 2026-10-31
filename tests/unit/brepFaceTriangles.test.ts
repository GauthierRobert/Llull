import { afterEach, describe, expect, it } from 'vitest';
import { type CadDocument, type Entity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import type { FaceQueryPort } from '@core/geometry/kernelPorts';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import { fakeKernel } from '../helpers/fakeKernel';
import { icosphere } from '../helpers/meshFixtures';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { xy } from '../helpers/xy';

afterEach(() => setGeometryKernel(null));

/** A kernel whose face-query port labels a point by the sign of its x (face 0 for x >= 0, face 1 otherwise) and has 2 faces. */
function labelling(distance: FaceQueryPort['distance'] | null = null): GeometryKernel {
  const nothing = (): null => null;
  const port: FaceQueryPort = {
    faceDetails: () => [
      { index: 0, surface: 'plane', area: 1, centroid: [1, 0, 0], samples: [] },
      { index: 1, surface: 'plane', area: 1, centroid: [-1, 0, 0], samples: [] },
    ],
    faceContains: nothing,
    faceGraph: nothing,
    faceGeometry: nothing,
    projectOnFace: nothing,
    evaluateFace: nothing,
    tessellateFace: nothing,
    faceSamples: nothing,
    edgeSamples: nothing,
    edgeContinuity: nothing,
    distance: distance ?? ((_shape, points) => points.map((p) => ({ distance: 0, signed: 0, face: p[0] >= 0 ? 0 : 1 }))),
    bspline: nothing,
    projectCurves: nothing,
  };
  return Object.assign(fakeKernel(), { faceQuery: port });
}

const run = (doc: CadDocument, params: unknown, kernel: GeometryKernel | null): ReturnType<typeof execute> =>
  execute(doc, 'inspect_face_triangles', params, { ...defaultContext(), kernel });

function box(): { doc: CadDocument; id: string } {
  const made = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
  return { doc: made.document, id: made.affected[0] as string };
}

describe('inspect_face_triangles', () => {
  it('labels every display triangle with the face the kernel names for its centroid, in viewport order; pure and read-only', () => {
    const { doc, id } = box();
    const result = run(doc, { entityId: id }, labelling());
    expect(result.error, result.summary).toBeUndefined();
    const data = result.data as { faceCount: number; triangleCount: number; faceOfTriangle: number[] };
    const triangles = entityToTriangles(doc.entities[id] as Entity, doc);
    expect(data.triangleCount).toBe(triangles.length);
    expect(data.faceCount).toBe(2);
    expect(data.faceOfTriangle).toEqual(triangles.map((t) => ((t[0][0] + t[1][0] + t[2][0]) / 3 >= 0 ? 0 : 1)));
    expect(new Set(data.faceOfTriangle)).toEqual(new Set([0, 1]));
    expectPure(doc, () => run(doc, { entityId: id }, labelling()));
    expect(result.document).toBe(doc);
  });

  it('refuses a missing id, a 2D shape, no exact kernel, a kernel that cannot answer, and a body over the triangle limit; each leaves the document unchanged', () => {
    const { doc, id } = box();
    const missing = run(doc, { entityId: 'nope' }, labelling());
    expect(missing.error?.code).toBe('ENTITY_NOT_FOUND');
    expectNoOp(missing, doc);
    const line = execute(doc, 'draw_polyline', { points: xy(0, 0, 1, 0) });
    const flat = run(line.document, { entityId: line.affected[0] }, labelling());
    expect(flat.error?.code).toBe('ENTITY_NOT_SOLID');
    expectNoOp(flat, line.document);
    const noKernel = run(doc, { entityId: id }, null);
    expect(noKernel.error?.code).toBe('CMD_KERNEL_UNAVAILABLE');
    expectNoOp(noKernel, doc);
    const bare = run(doc, { entityId: id }, fakeKernel());
    expect(bare.error?.code).toBe('KRN_NO_EXACT_KERNEL');
    expectNoOp(bare, doc);
    const failing = run(
      doc,
      { entityId: id },
      labelling(() => null),
    );
    expect(failing.error?.code).toBe('KRN_FACE_QUERY_FAILED');
    expectNoOp(failing, doc);
    const sphere = icosphere(1, 7);
    const heavy: CadDocument = {
      ...doc,
      entities: { ...doc.entities, [id]: { ...(doc.entities[id] as Entity), kind: 'mesh', mesh: sphere } as unknown as Entity },
    };
    const refused = run(heavy, { entityId: id }, labelling());
    expect(refused.error?.code).toBe('KRN_TRIANGLE_LIMIT');
    expectNoOp(refused, heavy);
  });
});
