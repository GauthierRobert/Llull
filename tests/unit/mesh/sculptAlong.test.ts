/** `sculpt_mesh` `along` (07 MSH FR-MSH-18, TECHNICAL_SPEC 13.19): stamps every `spacing` along a polyline or a nurbs_curve, then the same engines and bytes as explicit stamps. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { MAX_STROKE_STAMPS, stampsAlong } from '@core/geometry/mesh/strokePath';
import type { MeshSolidEntity } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { docWithMeshes, gridMesh } from '../../helpers/meshFixtures';

const meshOf = (result: { document: { entities: Record<string, unknown> }; affected: string[] }): MeshSolidEntity['mesh'] =>
  (result.document.entities[result.affected[0] as string] as MeshSolidEntity).mesh;

describe('stampsAlong', () => {
  it('places a stamp at the start and at every spacing of arc length round the corners of the path', () => {
    const path: Array<[number, number, number]> = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
    ];
    expect(stampsAlong(path, 4)).toEqual([
      [0, 0, 0],
      [4, 0, 0],
      [8, 0, 0],
      [10, 2, 0],
      [10, 6, 0],
      [10, 10, 0],
    ]);
    // the end is a stamp only when it falls on a multiple (the last of 20 / 6 is at 18)
    expect(stampsAlong(path, 6)).toHaveLength(4);
    expect(stampsAlong(path, 6)?.at(-1)).toEqual([10, 8, 0]);
  });

  it('skips segments of no length and refuses a path without length or with too many stamps', () => {
    const doubled: Array<[number, number, number]> = [
      [0, 0, 0],
      [0, 0, 0],
      [3, 0, 0],
    ];
    expect(stampsAlong(doubled, 1)).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ]);
    expect(
      stampsAlong(
        [
          [1, 1, 1],
          [1, 1, 1],
        ],
        1,
      ),
    ).toBeNull();
    expect(
      stampsAlong(
        [
          [0, 0, 0],
          [MAX_STROKE_STAMPS, 0, 0],
        ],
        1,
      ),
    ).toBeNull();
    expect(
      stampsAlong(
        [
          [0, 0, 0],
          [MAX_STROKE_STAMPS - 1, 0, 0],
        ],
        1,
      ),
    ).toHaveLength(MAX_STROKE_STAMPS);
  });
});

describe('sculpt_mesh along', () => {
  const plate = gridMesh(20, 80);
  const { doc, ids } = docWithMeshes(plate);
  const id = ids[0] as string;
  const base = { id, brush: 'draw', radius: 2, strength: 0.5, falloff: 'smooth' } as const;

  it('gives the bytes of the explicit stamps it stands for, from a polyline', () => {
    const along = execute(doc, 'sculpt_mesh', {
      ...base,
      along: {
        points: [
          [4, 10, 0],
          [16, 10, 0],
        ],
        spacing: 3,
      },
    });
    expect(along.error, along.summary).toBeUndefined();
    const explicit = execute(doc, 'sculpt_mesh', { ...base, stamps: [4, 7, 10, 13, 16].map((x) => ({ center: [x, 10, 0] })) });
    expect(meshOf(along).positions).toEqual(meshOf(explicit).positions);
    expect((along.data as { stamps: number }).stamps).toBe(5);
    expect(along.summary).toContain('x5');
    expect((along.data as { movedVertices: number }).movedVertices).toBeGreaterThan(100);
  });

  it('follows a nurbs_curve (the same stroke as its sampled polyline) in its world placement', () => {
    const curve = execute(doc, 'interpolate_curve', {
      points: [
        [0, 0, 0],
        [6, 0, 0],
        [12, 0, 0],
      ],
      degree: 2,
      position: [4, 10, 0],
    });
    expect(curve.error, curve.summary).toBeUndefined();
    const withCurve = { ...doc, entities: { ...doc.entities, ...curve.document.entities }, order: curve.document.order };
    const along = execute(withCurve, 'sculpt_mesh', { ...base, along: { curveId: curve.affected[0] as string, spacing: 3 } });
    expect(along.error, along.summary).toBeUndefined();
    expect((along.data as { stamps: number }).stamps).toBe(5);
    const explicit = execute(doc, 'sculpt_mesh', { ...base, stamps: [4, 7, 10, 13, 16].map((x) => ({ center: [x, 10, 0] })) });
    // the curve is a straight line, so its arc-length samples are the polyline stamps (to the sampling accuracy of the curve)
    const [a, b] = [meshOf(along).positions, meshOf(explicit).positions];
    expect(Math.max(...a.map((v, i) => Math.abs(v - (b[i] as number))))).toBeLessThan(1e-6);
  });

  it('is refused by name: both or neither of stamps and along, a path with two sources, no length, too many stamps, a bad curve, a stamp off the surface; and is pure', () => {
    const points = [
      [4, 10, 0],
      [16, 10, 0],
    ] as Array<[number, number, number]>;
    const both = execute(doc, 'sculpt_mesh', { ...base, stamps: [{ center: [4, 10, 0] }], along: { points, spacing: 3 } });
    expectNoOp(both, doc, 'MESH_PARAM_INVALID');
    expectNoOp(execute(doc, 'sculpt_mesh', { ...base }), doc, 'MESH_PARAM_INVALID');
    expectNoOp(execute(doc, 'sculpt_mesh', { ...base, along: { points, curveId: 'c', spacing: 3 } }), doc, 'MESH_PARAM_INVALID');
    expectNoOp(execute(doc, 'sculpt_mesh', { ...base, along: { spacing: 3 } }), doc, 'MESH_PARAM_INVALID');
    expectNoOp(
      execute(doc, 'sculpt_mesh', { ...base, along: { points: [points[0], points[0]] as typeof points, spacing: 1 } }),
      doc,
      'MESH_PARAM_INVALID',
    );
    expectNoOp(
      execute(doc, 'sculpt_mesh', {
        ...base,
        along: {
          points: [
            [0, 0, 0],
            [20, 0, 0],
          ],
          spacing: 0.001,
        },
      }),
      doc,
      'MESH_PARAM_INVALID',
    );
    expectNoOp(execute(doc, 'sculpt_mesh', { ...base, along: { curveId: 'ghost', spacing: 3 } }), doc, 'SRF_ENTITY_NOT_FOUND');
    expectNoOp(execute(doc, 'sculpt_mesh', { ...base, along: { curveId: id, spacing: 3 } }), doc, 'SRF_NOT_NURBS');
    expectNoOp(
      execute(doc, 'sculpt_mesh', {
        ...base,
        along: {
          points: [
            [4, 10, 30],
            [16, 10, 30],
          ],
          spacing: 3,
        },
      }),
      doc,
      'MESH_SCULPT_STAMP_OFF_SURFACE',
    );
    expectPure(doc, () => execute(doc, 'sculpt_mesh', { ...base, along: { points, spacing: 3 } }));
  });
});
