/** 03 WRP wrap_overlay: the curves on faces (placed, lineage read from the history) and the edges with their convexity, as polylines to draw (read-only); the fake corner kernel gives one sharp edge. */

import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { newEntity } from '@core/commands/entity/newEntity';
import { withEntity } from '@core/commands/entity/entityOps';
import type { BaseEntity, CadDocument, FeatureStep, NurbsCurveEntity, ShapeRecipe, Vec3 } from '@core/model/types';
import { fakeSplitKernel } from '../../helpers/fakeSplitKernel';
import { emptyDoc, make } from './support';

afterEach(() => setGeometryKernel(null));

const line = (a: Vec3, b: Vec3): NurbsCurveEntity['curve'] => ({ degree: 1, poles: [a, b], knots: [0, 1], multiplicities: [2, 2] });
function withCurve(
  doc: CadDocument,
  id: string,
  solid: string,
  face: number,
  placement: { position?: Vec3; rotation?: Vec3 } = {},
): CadDocument {
  const curve = newEntity(
    'nurbs_curve',
    id,
    {
      curve: line([0, 0, 0], [10, 0, 0]),
      onFace: {
        entityId: solid,
        faceIndex: face,
        faceName: `${solid}:f${face}`,
        pcurve: {
          degree: 1,
          poles: [
            [0, 0],
            [1, 0],
          ],
          knots: [0, 1],
          multiplicities: [2, 2],
        },
        frame: 'native' as const,
        fitTolerance: 1e-6,
        chartLength: 10,
      },
    } satisfies Omit<NurbsCurveEntity, keyof BaseEntity>,
    placement.position ?? [1, 2, 3],
    '#ffffff',
  );
  return withEntity(doc, placement.rotation === undefined ? curve : { ...curve, rotation: placement.rotation });
}
/** The history says `result` was made from `from` (a split consumes the solid it is given). */
const madeFrom = (doc: CadDocument, from: string, result: string, name = 'split_at_silhouette'): CadDocument => ({
  ...doc,
  featureHistory: [
    ...doc.featureHistory,
    { id: `step-${doc.featureHistory.length + 1}`, name, params: { id: from }, affected: [result] } satisfies FeatureStep,
  ],
});
const data = (result: ReturnType<typeof execute>): Record<string, unknown> => result.data as Record<string, unknown>;
type Curve = { id: string; face: number; source: string; points: Vec3[]; length: number };

describe('wrap_overlay', () => {
  it('lists the curves on the faces of the solid (sampled, at their position) and its edges with their convexity, and changes nothing', () => {
    setGeometryKernel(fakeSplitKernel({ corner: { convexity: 'convex' } }));
    const solid = make(emptyDoc(), 'add_box', { size: [60, 40, 10] });
    const doc = withCurve(solid.doc, 'curve-9.1', solid.id, 1);
    const before = JSON.stringify(doc);
    const done = execute(doc, 'wrap_overlay', { id: solid.id, samples: 5 });
    expect(done.rejected, done.summary).toBeUndefined();
    const curves = data(done)['curves'] as Curve[];
    expect(curves).toHaveLength(1);
    expect(curves[0]).toMatchObject({ id: 'curve-9.1', face: 1, source: 'solid', length: 10 });
    expect(curves[0]?.points).toHaveLength(5);
    expect(curves[0]?.points[0]).toEqual([1, 2, 3]);
    expect(curves[0]?.points[4]).toEqual([11, 2, 3]);
    const edges = data(done)['edges'] as Array<{ edge: number; faces: number[]; convexity: string; points: Vec3[] }>;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ edge: 0, faces: [0, 1], convexity: 'convex' });
    expect(edges[0]?.points).toHaveLength(5);
    expect(done.summary).toContain('1 curve(s)');
    expect(JSON.stringify(done.document)).toBe(before);
    expect(done.document).toBe(doc);
  });

  it('samples the placed curve: a curve turned a quarter about z runs along y', () => {
    setGeometryKernel(null);
    const solid = make(emptyDoc(), 'add_box', { size: [10, 10, 10] });
    const doc = withCurve(solid.doc, 'curve-1', solid.id, 0, { position: [5, 0, 0], rotation: [0, 0, Math.PI / 2] });
    const points = (data(execute(doc, 'wrap_overlay', { id: solid.id, samples: 2 }))['curves'] as Curve[])[0]?.points as Vec3[];
    expect(points[0]).toEqual([5, 0, 0]);
    expect(points[1]?.[0]).toBeCloseTo(5, 9);
    expect(points[1]?.[1]).toBeCloseTo(10, 9);
    expect(points[1]?.[2]).toBeCloseTo(0, 9);
  });

  it('keeps the curves of the solid this one was made from (the history says so) and leaves out those of an unrelated gone solid and of another solid', () => {
    setGeometryKernel(fakeSplitKernel({ corner: { convexity: 'concave' } }));
    const a = make(emptyDoc(), 'add_box', { size: [10, 10, 10] });
    const b = make(a.doc, 'add_box', { size: [5, 5, 5] });
    let doc = madeFrom(b.doc, 'gone-1', a.id);
    doc = withCurve(doc, 'curve-1', 'gone-1', 0);
    doc = withCurve(doc, 'curve-2', 'gone-9', 0);
    doc = withCurve(doc, 'curve-3', b.id, 0);
    const forA = execute(doc, 'wrap_overlay', { id: a.id });
    expect((data(forA)['curves'] as Curve[]).map((c) => [c.id, c.source])).toEqual([['curve-1', 'earlier']]);
    const forB = execute(doc, 'wrap_overlay', { id: b.id });
    expect((data(forB)['curves'] as Curve[]).map((c) => [c.id, c.source])).toEqual([['curve-3', 'solid']]);
  });

  it('follows the lineage through several steps, and stops on a cycle', () => {
    setGeometryKernel(null);
    const solid = make(emptyDoc(), 'add_box', { size: [10, 10, 10] });
    let doc = madeFrom(madeFrom(solid.doc, 'gone-1', 'gone-2'), 'gone-2', solid.id, 'split_face_by_curves');
    doc = withCurve(doc, 'curve-1', 'gone-1', 0);
    expect((data(execute(doc, 'wrap_overlay', { id: solid.id }))['curves'] as Curve[]).map((c) => c.id)).toEqual(['curve-1']);
    const cycle = madeFrom(madeFrom(solid.doc, solid.id, 'gone-1'), 'gone-1', solid.id);
    expect(execute(withCurve(cycle, 'curve-2', 'gone-1', 0), 'wrap_overlay', { id: solid.id }).rejected).toBeUndefined();
  });

  it('without an exact kernel the curves are still there and the edges say why they are not', () => {
    setGeometryKernel(null);
    const solid = make(emptyDoc(), 'add_box', { size: [10, 10, 10] });
    const done = execute(withCurve(solid.doc, 'curve-1', solid.id, 0), 'wrap_overlay', { id: solid.id });
    expect(done.rejected).toBeUndefined();
    expect(data(done)['edges']).toBeNull();
    expect(data(done)['edgesNote']).toContain('no exact kernel');
    expect(data(done)['curves'] as unknown[]).toHaveLength(1);
  });

  it('a kernel that cannot build the solid, or gives no face graph, leaves the curves and names the reason', () => {
    const solid = make(emptyDoc(), 'add_cylinder', { radius: 5, height: 5 });
    setGeometryKernel(fakeSplitKernel({ corner: { convexity: 'convex' } }));
    const refused = execute(withCurve(solid.doc, 'curve-1', solid.id, 0), 'wrap_overlay', { id: solid.id });
    expect(refused.rejected).toBeUndefined();
    expect(data(refused)['edges']).toBeNull();
    expect(data(refused)['edgesNote']).toContain('could not build');
    expect(data(refused)['curves'] as unknown[]).toHaveLength(1);
    const box = make(emptyDoc(), 'add_box', { size: [10, 10, 10] });
    const base = fakeSplitKernel({ corner: { convexity: 'convex' } });
    const noGraph: GeometryKernel = {
      ...base,
      faceQuery: { ...(base.faceQuery as NonNullable<typeof base.faceQuery>), faceGraph: () => null },
    };
    setGeometryKernel(noGraph);
    const none = execute(box.doc, 'wrap_overlay', { id: box.id });
    expect(data(none)['edges']).toBeNull();
    expect(data(none)['edgesNote']).toContain('no face graph');
  });

  it('caps the curves and the edges and reports what was left out', () => {
    const base = fakeSplitKernel({ corner: { convexity: 'convex' } });
    const query = base.faceQuery as NonNullable<typeof base.faceQuery>;
    const many: GeometryKernel = {
      ...base,
      faceQuery: {
        ...query,
        faceGraph: (shape) => {
          const graph = query.faceGraph(shape);
          return graph === null
            ? null
            : {
                ...graph,
                edgeFaces: Array.from({ length: 450 }, () => [0, 1]),
                edgeConvexity: Array.from({ length: 450 }, () => 'smooth' as const),
              };
        },
      },
    };
    setGeometryKernel(many);
    const solid = make(emptyDoc(), 'add_box', { size: [10, 10, 10] });
    let doc = solid.doc;
    for (let k = 0; k < 70; k++) doc = withCurve(doc, `curve-${k}`, solid.id, 0);
    const done = execute(doc, 'wrap_overlay', { id: solid.id, samples: 2 });
    expect(data(done)['curves'] as unknown[]).toHaveLength(64);
    expect(data(done)['edges'] as unknown[]).toHaveLength(400);
    expect(data(done)['truncated']).toEqual({ curves: 6, edges: 50 });
    expect(done.summary).toContain('+6 left out');
    expect(done.summary).toContain('+50 left out');
  });

  it('refuses an unknown id and an entity that is not a 3D solid, by name, without changing the document', () => {
    setGeometryKernel(null);
    const solid = make(emptyDoc(), 'add_box', { size: [10, 10, 10] });
    const doc = withCurve(solid.doc, 'curve-1', solid.id, 0);
    const missing = execute(doc, 'wrap_overlay', { id: 'nope' });
    expect(missing.error?.code).toBe('WRP_ENTITY_NOT_FOUND');
    expect(missing.document).toBe(doc);
    const notSolid = execute(doc, 'wrap_overlay', { id: 'curve-1' });
    expect(notSolid.error?.code).toBe('WRP_NOT_A_SOLID');
    expect(notSolid.document).toBe(doc);
  });
});

describe('wrap_overlay placement (world coordinates)', () => {
  it('opens a moved and rotated kernel result through its PLACED recipe, so the kernel edge samples are already world and are not moved again', () => {
    const base = fakeSplitKernel({ corner: { convexity: 'convex' } });
    const seen: ShapeRecipe[] = [];
    const spy: GeometryKernel = {
      ...base,
      evaluate: (recipe) => {
        seen.push(recipe);
        return base.evaluate(recipe.op === 'place' ? recipe.source : recipe);
      },
    };
    setGeometryKernel(spy);
    const box = make(emptyDoc(), 'add_box', { size: [60, 40, 10] });
    const leaf = box.doc.entities[box.id] as BaseEntity & { kind: string };
    const position: Vec3 = [4, 5, 6];
    const rotation: Vec3 = [0.1, 0.2, 0.3];
    const solid = {
      ...leaf,
      id: 'm',
      kind: 'mesh',
      mesh: { positions: [], indices: [] },
      brep: { op: 'solid', entity: leaf },
      position,
      rotation,
    };
    const doc: CadDocument = { ...box.doc, entities: { ...box.doc.entities, m: solid as never }, order: [...box.doc.order, 'm'] };
    const done = execute(doc, 'wrap_overlay', { id: 'm', samples: 3 });
    expect(done.rejected, done.summary).toBeUndefined();
    expect(seen.at(-1)).toMatchObject({ op: 'place', position, rotation });
    const plain = data(execute(box.doc, 'wrap_overlay', { id: box.id, samples: 3 }))['edges'] as Array<{ points: Vec3[] }>;
    expect((data(done)['edges'] as Array<{ points: Vec3[] }>)[0]?.points).toEqual(plain[0]?.points);
  });
});
