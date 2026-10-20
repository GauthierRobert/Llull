import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type NurbsSurfaceEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { validateEntityValue } from '@core/commands/persistence/guards';
import { entityBounds } from '@core/geometry/bounds';
import { surfaceTriangles } from '@core/geometry/nurbsSurface';
import { collectExportTriangles } from '@core/geometry/entityTriangles';
import { evaluateSurface } from '@lib/nurbs/surface';
import { extractSubSurface } from '@lib/nurbs/surfaceEdit';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import { isSheet } from '@core/model/curveKinds';
import { is3D } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { cylinderSurface, sphereSurface } from '../../helpers/revolvedSurfaces';

const empty = createEmptyDocument();

/** `create_nurbs_surface` params for `surface`. */
const paramsOf = (surface: NurbsSurfaceData, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  degreeU: surface.degreeU,
  degreeV: surface.degreeV,
  poles: surface.poles,
  ...(surface.weights === undefined ? {} : { weights: surface.weights }),
  knotsU: surface.knotsU,
  multiplicitiesU: surface.multiplicitiesU,
  knotsV: surface.knotsV,
  multiplicitiesV: surface.multiplicitiesV,
  ...extra,
});

const addSurface = (doc: CadDocument, surface: NurbsSurfaceData, extra: Record<string, unknown> = {}): { doc: CadDocument; id: string } => {
  const result = execute(doc, 'create_nurbs_surface', paramsOf(surface, extra));
  expect(result.affected).toHaveLength(1);
  return { doc: result.document, id: result.affected[0]! };
};

const addCurve = (doc: CadDocument, params: Record<string, unknown>): { doc: CadDocument; id: string } => {
  const result = execute(doc, 'create_nurbs_curve', params);
  expect(result.affected).toHaveLength(1);
  return { doc: result.document, id: result.affected[0]! };
};

const data = <T = Record<string, unknown>>(result: ReturnType<typeof execute>): T => result.data as T;

describe('create_nurbs_surface', () => {
  it('creates a valid sheet that is not a solid, with bounds, scale and persistence', () => {
    const { doc, id } = addSurface(empty, sphereSurface(10), { name: 'ball' });
    const entity = doc.entities[id] as NurbsSurfaceEntity;
    expect(entity.kind).toBe('nurbs_surface');
    expect(doc.order).toEqual([id]);
    expect([is3D(entity), isSheet(entity)]).toEqual([false, true]);
    expect(entityBounds(entity).max[0]).toBeCloseTo(10, 9);
    const scaled = execute(doc, 'scale_entity', { id, factor: 2 });
    expect(entityBounds(scaled.document.entities[id]!).max[0]).toBeCloseTo(20, 9);
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(JSON.stringify((loaded.entities[id] as NurbsSurfaceEntity).surface)).toBe(JSON.stringify(entity.surface));
    expect(collectExportTriangles(doc, undefined).tris).toHaveLength(0);
  });

  it.each([
    [
      'ragged grid',
      {
        poles: [
          [
            [0, 0, 0],
            [1, 0, 0],
          ],
          [[0, 1, 0]],
        ],
        degreeU: 1,
        degreeV: 1,
      },
    ],
    [
      'too few poles for the degree',
      {
        poles: [
          [
            [0, 0, 0],
            [1, 0, 0],
          ],
          [
            [0, 1, 0],
            [1, 1, 0],
          ],
        ],
        degreeU: 3,
        degreeV: 1,
      },
    ],
    [
      'bad degree',
      {
        poles: [
          [
            [0, 0, 0],
            [1, 0, 0],
          ],
          [
            [0, 1, 0],
            [1, 1, 0],
          ],
        ],
        degreeU: 0,
        degreeV: 1,
      },
    ],
    [
      'non-positive weight',
      {
        poles: [
          [
            [0, 0, 0],
            [1, 0, 0],
          ],
          [
            [0, 1, 0],
            [1, 1, 0],
          ],
        ],
        degreeU: 1,
        degreeV: 1,
        weights: [
          [1, 1],
          [1, -1],
        ],
      },
    ],
  ])('refuses %s', (_name, params) => {
    const result = execute(empty, 'create_nurbs_surface', params);
    expectNoOp(result, empty);
    expect(result.error?.code).toBe('SRF_NURBS_INVALID');
  });

  it('is pure', () => {
    expectPure(empty, () => execute(empty, 'create_nurbs_surface', paramsOf(cylinderSurface(5, 8))));
  });

  it('save / load rejects a corrupted sheet', () => {
    const { doc, id } = addSurface(empty, sphereSurface(10));
    const entity = doc.entities[id] as unknown as Record<string, unknown>;
    const broken = { ...entity, surface: { ...(entity['surface'] as object), degreeU: 9 } };
    expect(validateEntityValue(JSON.parse(JSON.stringify(entity)))).toBeNull();
    expect(validateEntityValue(broken)).toMatch(/surface/);
  });
});

describe('surface_from_points', () => {
  const grid = Array.from({ length: 5 }, (_, i) => Array.from({ length: 6 }, (_, j) => [i * 2, j * 2, Math.sin(i) * Math.cos(j)]));

  it('interpolates the grid (VC-SRF-25) and reports a round-off residual', () => {
    const result = execute(empty, 'surface_from_points', { grid });
    expect(result.affected).toHaveLength(1);
    const surface = (result.document.entities[result.affected[0]!] as NurbsSurfaceEntity).surface;
    expect(surface.poles).toHaveLength(5);
    expect(result.summary).toMatch(/max residual/);
    const control = execute(empty, 'surface_from_points', { grid, mode: 'control_net' });
    expect((control.document.entities[control.affected[0]!] as NurbsSurfaceEntity).surface.poles).toEqual(grid);
  });

  it('refuses a ragged grid and a too small grid', () => {
    expectNoOp(
      execute(empty, 'surface_from_points', {
        grid: [
          [
            [0, 0, 0],
            [1, 0, 0],
          ],
          [[0, 1, 0]],
        ],
      }),
      empty,
    );
    const tiny = execute(empty, 'surface_from_points', { grid: [[[0, 0, 0]]] });
    expectNoOp(tiny, empty);
    expect(tiny.error?.code).toBe('SRF_POINTS_INSUFFICIENT');
  });
});

describe('inspect_nurbs on a surface, trim_surface', () => {
  const { doc, id } = addSurface(empty, sphereSurface(10));

  it('reports the definition', () => {
    const result = execute(doc, 'inspect_nurbs', { id });
    expect(data(result)['type']).toBe('nurbs_surface');
    expect(data(result)['degreeU']).toBe(2);
    expect(data(result)['rational']).toBe(true);
  });

  it('trims to a parameter rectangle exactly and keeps the id', () => {
    const result = execute(doc, 'trim_surface', { id, u: [0.1, 0.6], v: [0.2, 0.7] });
    expect(result.affected).toEqual([id]);
    const part = (result.document.entities[id] as NurbsSurfaceEntity).surface;
    expect(evaluateSurface(part, 0.3, 0.4)[0]).toBeCloseTo(evaluateSurface(sphereSurface(10), 0.3, 0.4)[0], 9);
    expect(result.document.order).toEqual(doc.order);
  });

  it('refuses bad ranges, unknown ids and non-surfaces', () => {
    expect(execute(doc, 'trim_surface', { id, u: [0.6, 0.1], v: [0, 1] }).error?.code).toBe('SRF_TRIM_RANGE');
    expect(execute(doc, 'trim_surface', { id, u: [0, 2], v: [0, 1] }).error?.code).toBe('SRF_TRIM_RANGE');
    expect(execute(doc, 'trim_surface', { id: 'nope', u: [0, 1], v: [0, 1] }).error?.code).toBe('SRF_ENTITY_NOT_FOUND');
    const curve = addCurve(doc, {
      degree: 1,
      poles: [
        [0, 0, 0],
        [1, 0, 0],
      ],
    });
    expect(execute(curve.doc, 'trim_surface', { id: curve.id, u: [0, 1], v: [0, 1] }).error?.code).toBe('SRF_NOT_SURFACE');
    expectPure(doc, () => execute(doc, 'trim_surface', { id, u: [0.1, 0.6], v: [0.2, 0.7] }));
  });
});

describe('analyze_surface_curvature (VC-SRF-05)', () => {
  it('sphere R 10: K = 0.01, |H| = 0.1 everywhere off the poles; cylinder: K = 0', () => {
    const sphere = addSurface(empty, sphereSurface(10));
    const result = execute(sphere.doc, 'analyze_surface_curvature', { id: sphere.id, grid: [7, 9] });
    const out = data<{ minGaussian: number; maxGaussian: number; samples: Array<{ degenerate: boolean }>; degenerateSamples: number }>(
      result,
    );
    expect(out.maxGaussian).toBeCloseTo(0.01, 8);
    expect(out.minGaussian).toBeCloseTo(0.01, 8);
    expect(out.degenerateSamples).toBeGreaterThan(0);
    expect(out.samples).toHaveLength(63);
    const cyl = addSurface(empty, cylinderSurface(5, 8));
    const flat = data<{ maxGaussian: number; maxAbsCurvature: number }>(
      execute(cyl.doc, 'analyze_surface_curvature', {
        id: cyl.id,
        samples: [
          [0.2, 0.5],
          [0.7, 0.1],
        ],
      }),
    );
    expect(Math.abs(flat.maxGaussian)).toBeLessThan(1e-8);
    expect(flat.maxAbsCurvature).toBeCloseTo(0.2, 8);
  });

  it('omits the sample list for a large grid and refuses bad input', () => {
    const sphere = addSurface(empty, sphereSurface(10));
    const big = data<{ samples?: unknown; samplesOmitted?: string }>(
      execute(sphere.doc, 'analyze_surface_curvature', { id: sphere.id, grid: [60, 60] }),
    );
    expect(big.samples).toBeUndefined();
    expect(big.samplesOmitted).toBeDefined();
    expect(execute(sphere.doc, 'analyze_surface_curvature', { id: sphere.id, grid: [1, 5] }).error?.code).toBe('SRF_PARAM_INVALID');
    expect(execute(sphere.doc, 'analyze_surface_curvature', { id: sphere.id, samples: [[2, 0]] }).error?.code).toBe('SRF_PARAM_INVALID');
    expect(execute(sphere.doc, 'analyze_surface_curvature', { id: 'x' }).error?.code).toBe('SRF_ENTITY_NOT_FOUND');
    const box = execute(empty, 'add_box', { size: [1, 1, 1] }).document;
    expect(execute(box, 'analyze_surface_curvature', { id: box.order[0]! }).error?.code).toBe('SRF_NOT_SURFACE');
    expectPure(sphere.doc, () => execute(sphere.doc, 'analyze_surface_curvature', { id: sphere.id }));
  });
});

describe('measure_deviation (VC-SRF-18)', () => {
  const sphere = addSurface(empty, sphereSurface(10));
  const onShell = (radius: number): number[][] =>
    [0, 1, 2, 3, 4, 5].map((k) => [
      radius * Math.cos(k) * Math.sin(1 + k * 0.3),
      radius * Math.sin(k) * Math.sin(1 + k * 0.3),
      radius * Math.cos(1 + k * 0.3),
    ]);

  it('points on radius 10.5 are 0.5 from a sphere R 10 (max = mean = rms), signed along the normal', () => {
    const result = execute(sphere.doc, 'measure_deviation', { id: sphere.id, points: onShell(10.5), tolerance: 0.6 });
    const out = data<{ max: number; mean: number; rms: number; pass: boolean; signed: { mean: number }; histogram: number[] }>(result);
    expect(out.max).toBeCloseTo(0.5, 6);
    expect(out.mean).toBeCloseTo(0.5, 6);
    expect(out.rms).toBeCloseTo(0.5, 6);
    expect(out.pass).toBe(true);
    expect(Math.abs(out.signed.mean)).toBeCloseTo(0.5, 6);
    expect(out.histogram.reduce((a, b) => a + b, 0)).toBe(6);
    expect(
      data<{ pass: boolean }>(execute(sphere.doc, 'measure_deviation', { id: sphere.id, points: onShell(10.5), tolerance: 0.4 })).pass,
    ).toBe(false);
  });

  it('measures an entity against a solid and a curve', () => {
    const withBox = execute(sphere.doc, 'add_box', { size: [2, 2, 2], position: [30, 0, 0] }).document;
    const boxId = withBox.order[1]!;
    const result = execute(withBox, 'measure_deviation', { id: boxId, referenceId: sphere.id, samples: 6 });
    expect(data<{ targetType: string; max: number }>(result).targetType).toBe('mesh');
    expect(data<{ max: number }>(result).max).toBeGreaterThan(18);
    const line = addCurve(sphere.doc, {
      degree: 1,
      poles: [
        [0, 0, 20],
        [1, 0, 20],
      ],
    });
    const toCurve = execute(line.doc, 'measure_deviation', { id: line.id, points: [[0.5, 3, 24]] });
    expect(data<{ max: number }>(toCurve).max).toBeCloseTo(5, 8);
  });

  it('compares a sheet or a curve with the target, and a sheet renders as polygons', () => {
    const bigger = addSurface(sphere.doc, sphereSurface(11));
    const result = execute(bigger.doc, 'measure_deviation', { id: sphere.id, referenceId: bigger.id, samples: 9 });
    expect(data<{ max: number; mean: number }>(result).max).toBeCloseTo(1, 6);
    expect(data<{ mean: number }>(result).mean).toBeCloseTo(1, 6);
    const line = addCurve(bigger.doc, {
      degree: 1,
      poles: [
        [20, 0, 0],
        [30, 0, 0],
      ],
    });
    const fromCurve = execute(line.doc, 'measure_deviation', { id: sphere.id, referenceId: line.id, samples: 5 });
    expect(data<{ max: number }>(fromCurve).max).toBeCloseTo(20, 6);
    const polygons = surfaceTriangles(sphereSurface(10), [1, 2, 3]);
    expect(polygons.length).toBeGreaterThan(50);
    expect(polygons[0]).toHaveLength(3);
  });

  it('refuses ambiguous or empty input', () => {
    expect(execute(sphere.doc, 'measure_deviation', { id: sphere.id }).error?.code).toBe('SRF_PARAM_INVALID');
    expect(execute(sphere.doc, 'measure_deviation', { id: sphere.id, points: [[0, 0, 0]], referenceId: sphere.id }).error?.code).toBe(
      'SRF_PARAM_INVALID',
    );
    expect(execute(sphere.doc, 'measure_deviation', { id: 'x', points: [[0, 0, 0]] }).error?.code).toBe('SRF_ENTITY_NOT_FOUND');
    expectPure(sphere.doc, () => execute(sphere.doc, 'measure_deviation', { id: sphere.id, points: onShell(10.5) }));
  });
});

describe('analyze_draft (VC-SRF-17)', () => {
  it('a cone pulled along its axis has a lateral draft of atan(r/h); a vertical wall is zero', () => {
    const cone = execute(empty, 'add_cone', { radius: 5, height: 10 });
    const result = execute(cone.document, 'analyze_draft', { id: cone.affected[0]!, pullDirection: [0, 0, 1], minDraftDeg: 1 });
    const out = data<{ maxDeg: number; undercut: boolean; samples: Array<{ draftDeg: number }> }>(result);
    expect(out.maxDeg).toBeCloseTo((Math.atan(0.5) * 180) / Math.PI, 0);
    expect(out.samples.some((s) => Math.abs(s.draftDeg - 26.565) < 0.3)).toBe(true);
    const cylinder = addSurface(empty, cylinderSurface(5, 8));
    const wall = data<{ minDeg: number; maxDeg: number; pass: boolean }>(
      execute(cylinder.doc, 'analyze_draft', { id: cylinder.id, pullDirection: [0, 0, 1], minDraftDeg: 1 }),
    );
    expect(Math.abs(wall.maxDeg)).toBeLessThan(1e-6);
    expect(wall.pass).toBe(false);
  });

  it('flip reverses a sheet and bad input is refused', () => {
    const tilted = addSurface(empty, {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [0, 0, 0],
          [0, 4, 0],
        ],
        [
          [3, 0, 3],
          [3, 4, 3],
        ],
      ],
      knotsU: [0, 1],
      multiplicitiesU: [2, 2],
      knotsV: [0, 1],
      multiplicitiesV: [2, 2],
    });
    const forward = data<{ minDeg: number }>(execute(tilted.doc, 'analyze_draft', { id: tilted.id, pullDirection: [0, 0, 1] }));
    const reversed = data<{ minDeg: number }>(
      execute(tilted.doc, 'analyze_draft', { id: tilted.id, pullDirection: [0, 0, 1], flip: true }),
    );
    expect(forward.minDeg).toBeCloseTo(-reversed.minDeg, 8);
    expect(Math.abs(forward.minDeg)).toBeCloseTo(45, 6);
    expect(execute(tilted.doc, 'analyze_draft', { id: tilted.id, pullDirection: [0, 0, 0] }).error?.code).toBe('SRF_PARAM_INVALID');
    expect(execute(tilted.doc, 'analyze_draft', { id: 'x', pullDirection: [0, 0, 1] }).error?.code).toBe('SRF_ENTITY_NOT_FOUND');
    const sketch = execute(empty, 'draw_rectangle', { width: 2, height: 1 }).document;
    expect(execute(sketch, 'analyze_draft', { id: sketch.order[0]!, pullDirection: [0, 0, 1] }).error?.code).toBe('SRF_NOT_ANALYSABLE');
  });
});

const S = Math.SQRT1_2;
const arc = (start: number[], apex: number[], end: number[]): Record<string, unknown> => ({
  degree: 2,
  poles: [start, apex, end],
  weights: [1, S, 1],
});

describe('check_continuity, curves (VC-SRF-06)', () => {
  const line = {
    degree: 1,
    poles: [
      [-1, 0, 0],
      [0, 0, 0],
    ],
  };
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> = [
    [
      'corner',
      line,
      {
        degree: 1,
        poles: [
          [0, 0, 0],
          [1, 1, 0],
        ],
      },
      'G0',
    ],
    ['line + tangent arc', line, arc([0, 0, 0], [5, 0, 0], [5, 5, 0]), 'G1'],
    [
      'line + y = x^3',
      line,
      {
        degree: 3,
        poles: [
          [0, 0, 0],
          [1 / 3, 0, 0],
          [2 / 3, 0, 0],
          [1, 1, 0],
        ],
      },
      'G2',
    ],
    [
      'line + y = x^4',
      line,
      {
        degree: 4,
        poles: [
          [0, 0, 0],
          [0.25, 0, 0],
          [0.5, 0, 0],
          [0.75, 0, 0],
          [1, 1, 0],
        ],
      },
      'G3',
    ],
    ['arc + same circle', arc([-5, 5, 0], [-5, 0, 0], [0, 0, 0]), arc([0, 0, 0], [5, 0, 0], [5, 5, 0]), 'G3'],
    ['arc R5 + arc R10', arc([-5, 5, 0], [-5, 0, 0], [0, 0, 0]), arc([0, 0, 0], [10, 0, 0], [10, 10, 0]), 'G1'],
  ];

  it.each(cases)('%s reaches exactly its analytic order', (_name, left, right, order) => {
    const a = addCurve(empty, left);
    const b = addCurve(a.doc, right);
    const result = execute(b.doc, 'check_continuity', { pairs: [{ a: { id: a.id }, b: { id: b.id } }] });
    const joint = data<{ joints: Array<{ order: string; g0Gap: number; g1AngleRad: number; g2Gap: number; g3Gap?: number }> }>(result)
      .joints[0]!;
    expect(joint.order).toBe(order);
    expect(joint.g0Gap).toBeLessThan(1e-12);
  });

  it('reports the analytic jumps: 45 degrees, curvature 0.2, d(kappa)/ds 6', () => {
    const a = addCurve(empty, line);
    const corner = addCurve(a.doc, {
      degree: 1,
      poles: [
        [0, 0, 0],
        [1, 1, 0],
      ],
    });
    expect(
      data<{ joints: Array<{ g1AngleRad: number }> }>(
        execute(corner.doc, 'check_continuity', { pairs: [{ a: { id: a.id }, b: { id: corner.id } }] }),
      ).joints[0]!.g1AngleRad,
    ).toBeCloseTo(Math.PI / 4, 9);
    const circle = addCurve(a.doc, arc([0, 0, 0], [5, 0, 0], [5, 5, 0]));
    expect(
      data<{ joints: Array<{ g2Gap: number }> }>(
        execute(circle.doc, 'check_continuity', { pairs: [{ a: { id: a.id }, b: { id: circle.id } }] }),
      ).joints[0]!.g2Gap,
    ).toBeCloseTo(0.2, 9);
    const cubic = addCurve(a.doc, {
      degree: 3,
      poles: [
        [0, 0, 0],
        [1 / 3, 0, 0],
        [2 / 3, 0, 0],
        [1, 1, 0],
      ],
    });
    expect(
      data<{ joints: Array<{ g3Gap: number }> }>(
        execute(cubic.doc, 'check_continuity', { pairs: [{ a: { id: a.id }, b: { id: cubic.id } }] }),
      ).joints[0]!.g3Gap,
    ).toBeCloseTo(6, 6);
  });

  it('require makes pass depend on the order; mismatches and bad input are refused', () => {
    const a = addCurve(empty, line);
    const b = addCurve(a.doc, {
      degree: 1,
      poles: [
        [0, 0, 0],
        [1, 1, 0],
      ],
    });
    const pair = { a: { id: a.id }, b: { id: b.id } };
    expect(data<{ pass: boolean }>(execute(b.doc, 'check_continuity', { pairs: [pair] })).pass).toBe(false);
    expect(data<{ pass: boolean }>(execute(b.doc, 'check_continuity', { pairs: [pair], require: 'G0' })).pass).toBe(true);
    const surf = addSurface(b.doc, cylinderSurface(5, 8));
    expect(execute(surf.doc, 'check_continuity', { pairs: [{ a: { id: a.id }, b: { id: surf.id } }] }).error?.code).toBe(
      'SRF_CONTINUITY_MISMATCH',
    );
    expect(execute(b.doc, 'check_continuity', { pairs: [] }).error?.code).toBe('SRF_PARAM_INVALID');
    expect(execute(b.doc, 'check_continuity', { pairs: [pair], g1AngleRad: -1 }).error?.code).toBe('SRF_PARAM_INVALID');
    expect(execute(b.doc, 'check_continuity', { pairs: [{ a: { id: 'x' }, b: { id: b.id } }] }).error?.code).toBe('SRF_ENTITY_NOT_FOUND');
    expectPure(b.doc, () => execute(b.doc, 'check_continuity', { pairs: [pair] }));
  });
});

describe('check_continuity, surfaces', () => {
  const sphere = sphereSurface(10);
  const halves = (): { doc: CadDocument; a: string; b: string } => {
    const left = extractSubSurface(sphere, [0, 0.5], [0, 1]) as NurbsSurfaceData;
    const right = extractSubSurface(sphere, [0.5, 1], [0, 1]) as NurbsSurfaceData;
    const first = addSurface(empty, left);
    const second = addSurface(first.doc, right);
    return { doc: second.doc, a: first.id, b: second.id };
  };

  it('two halves of a sphere join with G2 (side detected)', () => {
    const { doc, a, b } = halves();
    const result = execute(doc, 'check_continuity', { pairs: [{ a: { id: a }, b: { id: b } }], samples: 9, require: 'G2' });
    const joint = data<{
      joints: Array<{ order: string; pass: boolean; a: { side: string }; g0Gap: number; g1AngleRad: number; g2Gap: number }>;
    }>(result).joints[0]!;
    expect(joint.order).toBe('G2');
    expect(joint.pass).toBe(true);
    expect(joint.g0Gap).toBeLessThan(1e-9);
    expect(joint.g1AngleRad).toBeLessThan(1e-6);
    expect(joint.g2Gap).toBeLessThan(1e-6);
    expect(['u0', 'u1']).toContain(joint.a.side);
  });

  it('two planes at a right angle meet with G0 only', () => {
    const plane = (poles: number[][][]): NurbsSurfaceData => ({
      degreeU: 1,
      degreeV: 1,
      poles: poles as never,
      knotsU: [0, 1],
      multiplicitiesU: [2, 2],
      knotsV: [0, 1],
      multiplicitiesV: [2, 2],
    });
    const floor = addSurface(
      empty,
      plane([
        [
          [0, 0, 0],
          [0, 4, 0],
        ],
        [
          [3, 0, 0],
          [3, 4, 0],
        ],
      ]),
    );
    const wall = addSurface(
      floor.doc,
      plane([
        [
          [3, 0, 0],
          [3, 4, 0],
        ],
        [
          [3, 0, 3],
          [3, 4, 3],
        ],
      ]),
    );
    const result = execute(wall.doc, 'check_continuity', { pairs: [{ a: { id: floor.id, side: 'u1' }, b: { id: wall.id, side: 'u0' } }] });
    const joint = data<{ joints: Array<{ order: string; g1AngleRad: number }> }>(result).joints[0]!;
    expect(joint.order).toBe('G0');
    expect(joint.g1AngleRad).toBeCloseTo(Math.PI / 2, 9);
  });

  describe('parabolic cylinder z = x^2 / 2 (curvature varies along the surface)', () => {
    /** Degree (2, 1) patch: u runs along three x-poles, v along y; `shear` slants the v lines, `lead` is the x-pole row. */
    const patch = (xPoles: number[][], shear: number): NurbsSurfaceData => ({
      degreeU: 2,
      degreeV: 1,
      poles: xPoles.map(([x, z, dy]) => [
        [x, (dy as number) * shear, z as number],
        [x, 1 + (dy as number) * shear, z as number],
      ]),
      knotsU: [0, 1],
      multiplicitiesU: [3, 3],
      knotsV: [0, 1],
      multiplicitiesV: [2, 2],
    });
    const base = patch(
      [
        [0, 0, 0],
        [0.5, 0, 0],
        [1, 0.5, 0],
      ],
      0,
    );
    const join = (next: NurbsSurfaceData): { order: string; g1AngleRad: number; g2Gap: number } => {
      const first = addSurface(empty, base);
      const second = addSurface(first.doc, next);
      const result = execute(second.doc, 'check_continuity', {
        pairs: [{ a: { id: first.id, side: 'u1' }, b: { id: second.id, side: 'u0' } }],
        samples: 7,
      });
      return data<{ joints: Array<{ order: string; g1AngleRad: number; g2Gap: number }> }>(result).joints[0]!;
    };

    it('a continuation has G2 whatever its parametrisation (sheared v lines)', () => {
      const next = [
        [1, 0.5, 0],
        [1.5, 1, 0.5],
        [2, 2, 1],
      ];
      expect(join(patch(next, 0))).toMatchObject({ order: 'G2' });
      expect(join(patch(next, 0.8))).toMatchObject({ order: 'G2' });
    });

    it('a patch folded back over the first one is not G1', () => {
      const folded = join(
        patch(
          [
            [1, 0.5, 0],
            [0.5, 0, 0],
            [0, 0, 0],
          ],
          0,
        ),
      );
      expect(folded.order).toBe('G0');
      expect(folded.g1AngleRad).toBeCloseTo(Math.PI, 6);
    });
  });

  it('far apart patches report no order', () => {
    const { doc, a } = halves();
    const far = addSurface(doc, cylinderSurface(1, 1), { position: [100, 0, 0] });
    const result = execute(far.doc, 'check_continuity', { pairs: [{ a: { id: a }, b: { id: far.id } }] });
    expect(data<{ joints: Array<{ order: string }> }>(result).joints[0]!.order).toBe('none');
  });
});
