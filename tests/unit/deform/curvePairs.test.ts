import { afterEach, describe, expect, it } from 'vitest';
import { type CadDocument, type Entity, type MeshSolidEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { fitRbf, rbfDeterminant, rbfMap, samplesByArcLength } from '@core/geometry/deform/rbf';
import { evaluateCurve, curveDomain } from '@lib/nurbs/evaluate';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { type KernelKind, addBox, dataOf, installKernel, meshEntity } from './harness';

afterEach(() => setGeometryKernel(null));

describe('displacement field through constraints (VC-DEF-33)', () => {
  const constraints = [
    { at: [0, 0, 0], delta: [0, 0, 0] },
    { at: [10, 0, 0], delta: [0, 2, 0] },
    { at: [0, 10, 0], delta: [1, 0, 0] },
    { at: [0, 0, 10], delta: [0, 0, -1] },
    { at: [10, 10, 10], delta: [0.5, 0.5, 0.5] },
  ] as const;

  it('interpolates every constraint exactly without smoothing, and relaxes with it', () => {
    const exact = fitRbf(constraints, 0);
    if (exact === null) throw new Error('no fit');
    for (const { at, delta } of constraints) {
      const image = rbfMap(exact, at);
      image.forEach((value, a) => expect(Math.abs(value - (at[a] as number) - (delta[a] as number))).toBeLessThan(1e-9));
    }
    const relaxed = fitRbf(constraints, 2000);
    if (relaxed === null) throw new Error('no fit');
    const moved = rbfMap(relaxed, [10, 0, 0]);
    expect(Math.abs(moved[1] - 2)).toBeGreaterThan(1e-3);
    expect(Number.isFinite(rbfDeterminant(exact, [3, 4, 5]))).toBe(true);
  });

  it('refuses no constraints and constraints that contradict each other', () => {
    expect(fitRbf([], 0)).toBeNull();
    expect(
      fitRbf(
        [
          { at: [1, 1, 1], delta: [0, 0, 0] },
          { at: [1, 1, 1], delta: [1, 0, 0] },
        ],
        0,
      ),
    ).toBeNull();
    expect(
      fitRbf(
        Array.from({ length: 401 }, (_, k) => ({ at: [k, 0, 0] as const, delta: [0, 0, 0] as const })),
        0,
      ),
    ).toBeNull();
  });

  it('samples a curve at equal fractions of its arc length, ends included', async () => {
    await installKernel('none');
    const made = execute(createEmptyDocument(), 'interpolate_curve', {
      points: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
      ],
      degree: 2,
    });
    const entity = made.document.entities[made.affected[0] as string];
    if (entity?.kind !== 'nurbs_curve') throw new Error('no curve');
    const points = samplesByArcLength(entity.curve, 5);
    expect(points).toHaveLength(5);
    const [first, last] = curveDomain(entity.curve);
    expect(points[0]).toEqual(evaluateCurve(entity.curve, first));
    expect(points[4]?.[0]).toBeCloseTo((evaluateCurve(entity.curve, last) as readonly number[])[0] as number, 9);
  });
});

function curve(doc: CadDocument, points: number[][]): { doc: CadDocument; id: string } {
  const made = execute(doc, 'interpolate_curve', { points, degree: 3 });
  return { doc: made.document, id: made.affected[0] as string };
}

describe.each<KernelKind>(['none', 'manifold', 'warp'])('deform_curve_to_curve, kernel: %s', (kind) => {
  function scene(): { doc: CadDocument; bar: string; initial: string; target: string } {
    const bar = addBox([10, 10, 100]);
    const line = [0, 25, 50, 75, 100].map((z) => [5, 0, z]);
    const goal = [0, 25, 50, 75, 100].map((z) => [5 + 20 * (z / 100) ** 2, 0, z]);
    const initial = curve(bar.doc, line);
    const target = curve(initial.doc, goal);
    return { doc: target.doc, bar: bar.id, initial: initial.id, target: target.id };
  }

  it('lands the initial curve on the target within the reported residual, holding the fixed points', async () => {
    await installKernel(kind);
    const { doc, bar, initial, target } = scene();
    const fixed = [
      [0, 0, 0],
      [-5, 0, 0],
      [5, 0, 0],
      [0, 5, 0],
      [0, -5, 0],
    ];
    const result = execute(doc, 'deform_curve_to_curve', {
      id: bar,
      pairs: [{ initialId: initial, targetId: target }],
      fixedPoints: fixed,
      output: { tolerance: 0.05 },
    });
    expect(result.error, result.summary).toBeUndefined();
    const data = dataOf<{ landing: { maxDistance: number; allowed: number }; constraints: number }>(result);
    expect(data.landing.maxDistance).toBeLessThan(data.landing.allowed);
    expect(data.constraints).toBe(24 + fixed.length);
    expect(meshEntity(result.document, result.affected[0] as string).brep).toMatchObject({ op: 'deform', law: { kind: 'rbf' } });
    const analysis = execute(result.document, 'analyze_deformation', { id: result.affected[0] });
    expect(analysis.error).toBeUndefined();
    expectPure(doc, () =>
      execute(doc, 'deform_curve_to_curve', { id: bar, pairs: [{ initialId: initial, targetId: target }], output: { tolerance: 0.05 } }),
    );
  });

  it('refuses bad pairs, a stiff fit that cannot land, and inconsistent constraints', async () => {
    await installKernel(kind);
    const { doc, bar, initial, target } = scene();
    const refused = (params: Record<string, unknown>, code: string): void => {
      const result = execute(doc, 'deform_curve_to_curve', { id: bar, ...params });
      expectNoOp(result, doc);
      expect(result.error?.code, result.summary).toBe(code);
    };
    refused({ pairs: [{ initialId: 'ghost', targetId: target }] }, 'DEF_CURVE_PAIR_INVALID');
    refused({ pairs: [{ initialId: initial, targetId: bar }] }, 'DEF_CURVE_PAIR_INVALID');
    refused({ pairs: [{ initialId: initial, targetId: target }], samples: 2 }, 'DEF_CURVE_PAIR_INVALID');
    refused({ pairs: [{ initialId: initial, targetId: target }], stiffness: 2 }, 'DEF_CURVE_PAIR_INVALID');
    refused({ pairs: [{ initialId: initial, targetId: target }], landingTolerance: 1e-6 }, 'DEF_APPROX_TOLERANCE');
    refused({ pairs: [{ initialId: initial, targetId: target }, { initialId: initial }] }, 'DEF_CURVE_PAIR_INVALID');
    refused({ pairs: [{ initialId: initial, targetId: target }], landingTolerance: -1 }, 'DEF_CURVE_PAIR_INVALID');
    refused(
      { pairs: Array.from({ length: 20 }, () => ({ initialId: initial, targetId: target })), samples: 100 },
      'DEF_CURVE_PAIR_INVALID',
    );
    expect(
      execute(doc, 'deform_curve_to_curve', {
        id: bar,
        pairs: [{ initialId: initial }],
        fixedPoints: [[9, 9, 9]],
        output: { tolerance: 0.05 },
      }).error?.code,
    ).toBe('DEF_NO_EFFECT');
  });
});

describe('morph_bodies (VC-DEF-34)', () => {
  const plane = (doc: CadDocument, z: number, degree = 1): { doc: CadDocument; id: string } => {
    const grid = Array.from({ length: degree + 1 }, (_, k) => k);
    const poles = grid.map((i) => grid.map((j) => [(i * 10) / degree, (j * 10) / degree, z]));
    const made = execute(doc, 'create_nurbs_surface', { degreeU: degree, degreeV: degree, poles });
    return { doc: made.document, id: made.affected[0] as string };
  };

  it('morphs two planes z 0 and z 10 at t 0.3 into the plane z 3, and t 0 / t 1 reproduce the ends', async () => {
    await installKernel('none');
    const a = plane(createEmptyDocument(), 0);
    const b = plane(a.doc, 10);
    const result = execute(b.doc, 'morph_bodies', { fromId: a.id, toId: b.id, t: 0.3 });
    expect(result.error, result.summary).toBeUndefined();
    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toEqual([...b.doc.order, result.affected[0]]);
    const morph = result.document.entities[result.affected[0] as string];
    if (morph?.kind !== 'nurbs_surface') throw new Error('no sheet');
    for (const row of morph.surface.poles) for (const pole of row) expect(pole[2]).toBeCloseTo(3, 12);
    for (const [t, z] of [
      [0, 0],
      [1, 10],
    ] as const) {
      const end = execute(b.doc, 'morph_bodies', { fromId: a.id, toId: b.id, t });
      const entity = end.document.entities[end.affected[0] as string];
      expect(entity?.kind === 'nurbs_surface' ? entity.surface.poles[1]?.[1]?.[2] : NaN).toBeCloseTo(z, 12);
    }
    expectPure(b.doc, () => execute(b.doc, 'morph_bodies', { fromId: a.id, toId: b.id, t: 0.3 }));
  });

  it('morphs curves (weights too) and meshes of the same connectivity', async () => {
    await installKernel('none');
    const first = curve(createEmptyDocument(), [
      [0, 0, 0],
      [1, 0, 0],
      [2, 1, 0],
      [3, 0, 0],
    ]);
    const second = curve(first.doc, [
      [0, 0, 5],
      [1, 0, 5],
      [2, 1, 5],
      [3, 0, 5],
    ]);
    const curves = execute(second.doc, 'morph_bodies', { fromId: first.id, toId: second.id, t: 0.5 });
    const made = curves.document.entities[curves.affected[0] as string];
    expect(made?.kind === 'nurbs_curve' ? made.curve.poles[0]?.[2] : NaN).toBeCloseTo(2.5, 12);
    const mesh = (id: string, shift: number): Entity => ({
      id,
      kind: 'mesh',
      mesh: { positions: [0, 0, shift, 1, 0, shift, 0, 1, shift], indices: [0, 1, 2] },
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#888888',
    });
    const doc: CadDocument = { ...createEmptyDocument(), entities: { m1: mesh('m1', 0), m2: mesh('m2', 4) }, order: ['m1', 'm2'] };
    const blended = execute(doc, 'morph_bodies', { fromId: 'm1', toId: 'm2', t: 0.25 });
    expect(meshEntity(blended.document, blended.affected[0] as string).mesh.positions[2]).toBeCloseTo(1, 12);
    const other: CadDocument = {
      ...doc,
      entities: {
        ...doc.entities,
        m3: { ...(mesh('m3', 1) as MeshSolidEntity), mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 2, 1] } },
      },
    };
    expect(execute(other, 'morph_bodies', { fromId: 'm1', toId: 'm3', t: 0.5 }).error?.code).toBe('DEF_MORPH_INCOMPATIBLE');
  });

  it('refuses other structure, other kinds, unknown ids and t outside 0..1', async () => {
    await installKernel('none');
    const a = plane(createEmptyDocument(), 0);
    const quadratic = plane(a.doc, 5, 2);
    const line = curve(quadratic.doc, [
      [0, 0, 0],
      [1, 0, 0],
      [2, 1, 0],
      [3, 0, 0],
    ]);
    const refused = (from: string, to: string, t: number, code: string): void => {
      const result = execute(line.doc, 'morph_bodies', { fromId: from, toId: to, t });
      expectNoOp(result, line.doc);
      expect(result.error?.code, result.summary).toBe(code);
    };
    refused(a.id, quadratic.id, 0.5, 'DEF_MORPH_INCOMPATIBLE');
    refused(a.id, line.id, 0.5, 'DEF_MORPH_INCOMPATIBLE');
    refused('ghost', a.id, 0.5, 'DEF_ENTITY_NOT_FOUND');
    refused(a.id, 'ghost', 0.5, 'DEF_ENTITY_NOT_FOUND');
    refused(a.id, a.id, 1.5, 'DEF_MORPH_PARAMETER');
    const boxes = addBox();
    const solid = execute(boxes.doc, 'add_box', { size: [1, 1, 1] });
    const twoBoxes = execute(solid.document, 'morph_bodies', { fromId: boxes.id, toId: solid.affected[0], t: 0.5 });
    expect(twoBoxes.error?.code).toBe('DEF_MORPH_INCOMPATIBLE');
  });
});

describe('morph_bodies of rational and rotated entities', () => {
  it('mixes the weights of two conics and works in world coordinates for rotated curves', async () => {
    await installKernel('none');
    const first = execute(createEmptyDocument(), 'create_conic', { start: [1, 0, 0], apex: [1, 1, 0], end: [0, 1, 0], rho: 0.3 });
    const second = execute(first.document, 'create_conic', { start: [1, 0, 0], apex: [1, 1, 0], end: [0, 1, 0], rho: 0.5 });
    const morphed = execute(second.document, 'morph_bodies', { fromId: first.affected[0], toId: second.affected[0], t: 0.5 });
    expect(morphed.error, morphed.summary).toBeUndefined();
    const made = morphed.document.entities[morphed.affected[0] as string];
    const weights = made?.kind === 'nurbs_curve' ? (made.curve.weights ?? []) : [];
    const [a, b] = [first.affected[0], second.affected[0]].map((id) => {
      const entity = second.document.entities[id as string];
      return entity?.kind === 'nurbs_curve' ? (entity.curve.weights?.[1] ?? NaN) : NaN;
    });
    expect(weights[1]).toBeCloseTo(((a as number) + (b as number)) / 2, 12);
    // a rotated copy of the first conic morphs in world coordinates: t 1 reproduces the rotated pole positions
    const rotated: CadDocument = {
      ...second.document,
      entities: {
        ...second.document.entities,
        [second.affected[0] as string]: {
          ...(second.document.entities[second.affected[0] as string] as Entity),
          rotation: [0, 0, Math.PI / 2],
        },
      },
    };
    const turned = execute(rotated, 'morph_bodies', { fromId: first.affected[0], toId: second.affected[0], t: 1 });
    const result = turned.document.entities[turned.affected[0] as string];
    expect(result?.kind === 'nurbs_curve' ? result.curve.poles[0]?.[1] : NaN).toBeCloseTo(1, 9);
    const rationalSheet = (doc: CadDocument, w: number): { doc: CadDocument; id: string } => {
      const made = execute(doc, 'create_nurbs_surface', {
        degreeU: 1,
        degreeV: 1,
        poles: [
          [
            [0, 0, 0],
            [0, 1, 0],
          ],
          [
            [1, 0, 0],
            [1, 1, 0],
          ],
        ],
        weights: [
          [1, 1],
          [1, w],
        ],
      });
      return { doc: made.document, id: made.affected[0] as string };
    };
    const sheetA = rationalSheet(createEmptyDocument(), 1);
    const sheetB = rationalSheet(sheetA.doc, 3);
    const mixed = execute(sheetB.doc, 'morph_bodies', { fromId: sheetA.id, toId: sheetB.id, t: 0.5 });
    const sheet = mixed.document.entities[mixed.affected[0] as string];
    expect(sheet?.kind === 'nurbs_surface' ? sheet.surface.weights?.[1]?.[1] : NaN).toBeCloseTo(2, 12);
    const plain = execute(sheetB.doc, 'create_nurbs_surface', {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [0, 0, 0],
          [0, 1, 0],
        ],
        [
          [1, 0, 0],
          [1, 1, 0],
        ],
      ],
    });
    expect(execute(plain.document, 'morph_bodies', { fromId: sheetA.id, toId: plain.affected[0], t: 0.5 }).error?.code).toBe(
      'DEF_MORPH_INCOMPATIBLE',
    );
    const knots = execute(sheetB.doc, 'create_nurbs_surface', {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [0, 0, 0],
          [0, 1, 0],
        ],
        [
          [1, 0, 0],
          [1, 1, 0],
        ],
      ],
      weights: [
        [1, 1],
        [1, 3],
      ],
      knotsU: [0, 2],
      multiplicitiesU: [2, 2],
    });
    expect(execute(knots.document, 'morph_bodies', { fromId: sheetA.id, toId: knots.affected[0], t: 0.5 }).error?.code).toBe(
      'DEF_MORPH_INCOMPATIBLE',
    );
    const quad = execute(first.document, 'create_conic', { start: [1, 0, 0], apex: [1, 1, 0], end: [0, 1, 0], rho: 0.4 });
    const lines = curve(quad.document, [
      [0, 0, 0],
      [1, 0, 0],
      [2, 1, 0],
      [3, 0, 0],
    ]);
    expect(execute(lines.doc, 'morph_bodies', { fromId: quad.affected[0], toId: lines.id, t: 0.5 }).error?.code).toBe(
      'DEF_MORPH_INCOMPATIBLE',
    );
  });
});
