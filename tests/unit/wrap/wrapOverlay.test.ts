/** 03 WRP wrap_overlay: the curves on faces and the edges with their convexity, as polylines to draw (read-only); the fake corner kernel gives one sharp edge. */

import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { newEntity } from '@core/commands/entity/newEntity';
import { withEntity } from '@core/commands/entity/entityOps';
import type { CadDocument, NurbsCurveEntity, BaseEntity, Vec3 } from '@core/model/types';
import { fakeSplitKernel } from '../../helpers/fakeSplitKernel';
import { emptyDoc, make } from './support';

afterEach(() => setGeometryKernel(null));

const line = (a: Vec3, b: Vec3): NurbsCurveEntity['curve'] => ({ degree: 1, poles: [a, b], knots: [0, 1], multiplicities: [2, 2] });
function withCurve(doc: CadDocument, id: string, solid: string, face: number): CadDocument {
  return withEntity(
    doc,
    newEntity(
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
      [1, 2, 3],
      '#ffffff',
    ),
  );
}
const data = (result: ReturnType<typeof execute>): Record<string, unknown> => result.data as Record<string, unknown>;

describe('wrap_overlay', () => {
  it('lists the curves on the faces of the solid (sampled, at their position) and its edges with their convexity', () => {
    setGeometryKernel(fakeSplitKernel({ corner: { convexity: 'convex' } }));
    const solid = make(emptyDoc(), 'add_box', { size: [60, 40, 10] });
    const doc = withCurve(solid.doc, 'curve-9.1', solid.id, 1);
    const done = execute(doc, 'wrap_overlay', { id: solid.id, samples: 5 });
    expect(done.rejected, done.summary).toBeUndefined();
    const curves = data(done)['curves'] as Array<{ id: string; face: number; source: string; points: Vec3[]; length: number }>;
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
    expect(done.document).toBe(doc);
  });

  it('keeps the curves of an earlier solid that no longer exists (a silhouette split), and leaves out those of another solid', () => {
    setGeometryKernel(fakeSplitKernel({ corner: { convexity: 'concave' } }));
    const a = make(emptyDoc(), 'add_box', { size: [10, 10, 10] });
    const b = make(a.doc, 'add_box', { size: [5, 5, 5] });
    let doc = withCurve(b.doc, 'curve-1', 'gone-1', 0);
    doc = withCurve(doc, 'curve-2', b.id, 0);
    const done = execute(doc, 'wrap_overlay', { id: a.id });
    expect((data(done)['curves'] as Array<{ id: string; source: string }>).map((c) => [c.id, c.source])).toEqual([['curve-1', 'earlier']]);
  });

  it('without an exact kernel the curves are still there and the edges say why they are not', () => {
    setGeometryKernel(null);
    const solid = make(emptyDoc(), 'add_box', { size: [10, 10, 10] });
    const doc = withCurve(solid.doc, 'curve-1', solid.id, 0);
    const done = execute(doc, 'wrap_overlay', { id: solid.id });
    expect(done.rejected).toBeUndefined();
    expect(data(done)['edges']).toBeNull();
    expect(data(done)['edgesNote']).toContain('no exact kernel');
    expect(data(done)['curves'] as unknown[]).toHaveLength(1);
  });

  it('caps the curves and reports what was left out; an unknown id is refused by name', () => {
    setGeometryKernel(null);
    const solid = make(emptyDoc(), 'add_box', { size: [10, 10, 10] });
    let doc = solid.doc;
    for (let k = 0; k < 70; k++) doc = withCurve(doc, `curve-${k}`, solid.id, 0);
    const done = execute(doc, 'wrap_overlay', { id: solid.id, samples: 2 });
    expect(data(done)['curves'] as unknown[]).toHaveLength(64);
    expect(data(done)['truncated']).toEqual({ curves: 6, edges: 0 });
    const missing = execute(doc, 'wrap_overlay', { id: 'nope' });
    expect(missing.error?.code).toBe('WRP_ENTITY_NOT_FOUND');
    expect(missing.document).toBe(doc);
  });
});
