/** SWG M1 leftovers: lawParameter arc_length, fitTolerance (VC-SWG-27), pathIds chains. */
import { describe, it, expect } from 'vitest';
import { type CadDocument, type SweepEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { pathLength } from '@core/geometry/sweepEval/evaluate';
import { sweepTriangles } from '@core/geometry/sweep';
import { isWatertight, volumeOf } from '../../helpers/fixtureDocument';
import { relError } from '../../helpers/swgPack';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { xyz } from '../../helpers/xy';

const empty = createEmptyDocument();
const BAR = xyz(0, 0, 0, 0, 0, 100);

function sweep(params: Record<string, unknown>, doc: CadDocument = empty): SweepEntity {
  const result = execute(doc, 'sweep_profile', params);
  expect(result.affected, result.summary).toHaveLength(1);
  return result.document.entities[result.affected[0] as string] as SweepEntity;
}

describe('lawParameter arc_length', () => {
  it('a table over the arc length is stored as the same table over the fraction', () => {
    const over = sweep({
      path: BAR,
      radius: 5,
      lawParameter: 'arc_length',
      scale: {
        type: 'table',
        points: [
          [0, 1],
          [40, 0.8],
          [100, 0.5],
        ],
      },
    });
    const fraction = sweep({
      path: BAR,
      radius: 5,
      scale: {
        type: 'table',
        points: [
          [0, 1],
          [0.4, 0.8],
          [1, 0.5],
        ],
      },
    });
    expect(over.scale).toEqual(fraction.scale);
  });
  it('end slopes are per unit length and converted too', () => {
    const entity = sweep({
      path: BAR,
      radius: 5,
      lawParameter: 'arc_length',
      scale: {
        type: 'table',
        points: [
          [0, 1],
          [100, 0.5],
        ],
        startSlope: 0,
        endSlope: -0.01,
      },
    });
    expect(entity.scale).toMatchObject({ type: 'table', endSlope: -1 });
  });
  it('a table that does not run to the path length is SWG_LAW_INVALID; other law types are unaffected', () => {
    const result = execute(empty, 'sweep_profile', {
      path: BAR,
      radius: 5,
      lawParameter: 'arc_length',
      scale: {
        type: 'table',
        points: [
          [0, 1],
          [50, 0.5],
        ],
      },
    });
    expectNoOp(result, empty, 'SWG_LAW_INVALID');
    expect(sweep({ path: BAR, radius: 5, lawParameter: 'arc_length', scale: { type: 'linear', start: 1, end: 0.5 } }).scale).toEqual({
      type: 'linear',
      start: 1,
      end: 0.5,
    });
  });
});

describe('fitTolerance', () => {
  const lawed = { path: BAR, radius: 5, scale: { type: 'linear', start: 1, end: 0.5 } };
  it('is stored and used by the fit', () => {
    expect(sweep({ ...lawed, fitTolerance: 1e-5 }).fitTolerance).toBe(1e-5);
  });
  it('a tolerance the fit cannot reach is SWG_FIT_TOLERANCE (VC-SWG-27); a non-positive one is SWG_PARAM_INVALID', () => {
    const tight = execute(empty, 'sweep_profile', {
      path: xyz(0, 0, 0, 0, 0, 100, 40, 0, 160),
      smooth: true,
      radius: 5,
      twist: { type: 'linear', start: 0, end: 20 },
      fitTolerance: 1e-12,
    });
    expectNoOp(tight, empty, 'SWG_FIT_TOLERANCE');
    expect(tight.error?.code).toBe('SWG_FIT_TOLERANCE');
    const bad = execute(empty, 'sweep_profile', { ...lawed, fitTolerance: -1 });
    expect(bad.error?.code).toBe('SWG_PARAM_INVALID');
  });
});

describe('pathIds chains', () => {
  const line = (doc: CadDocument, points: number[][]): { doc: CadDocument; id: string } => {
    const made = execute(doc, 'interpolate_curve', { points, degree: 1 });
    return { doc: made.document, id: made.affected[0] as string };
  };
  const two = (): { doc: CadDocument; a: string; b: string } => {
    const a = line(empty, [
      [0, 0, 0],
      [0, 0, 60],
    ]);
    const b = line(a.doc, [
      [0, 0, 60],
      [0, 0, 100],
    ]);
    return { doc: b.doc, a: a.id, b: b.id };
  };
  it('joins collinear curves end to end into one path of the summed length', () => {
    const { doc, a, b } = two();
    const entity = sweep({ pathIds: [a, b], radius: 5 }, doc);
    expect(pathLength(entity)).toBeCloseTo(100, 9);
  });
  it('reverses a curve whose far end meets the chain', () => {
    const a = line(empty, [
      [0, 0, 0],
      [0, 0, 60],
    ]);
    const b = line(a.doc, [
      [0, 0, 100],
      [0, 0, 60],
    ]);
    expect(pathLength(sweep({ pathIds: [a.id, b.id], radius: 5 }, b.doc))).toBeCloseTo(100, 9);
  });
  it('a gap, a sharp corner, a single id or a path alongside are refused', () => {
    const { doc, a, b } = two();
    const far = line(doc, [
      [0, 0, 200],
      [0, 0, 300],
    ]);
    expectNoOp(execute(far.doc, 'sweep_profile', { pathIds: [a, far.id], radius: 5 }), far.doc, 'SWG_PATH_INVALID');
    const corner = line(doc, [
      [0, 0, 100],
      [50, 0, 100],
    ]);
    expectNoOp(execute(corner.doc, 'sweep_profile', { pathIds: [a, b, corner.id], radius: 5 }), corner.doc, 'SWG_PATH_NOT_G1');
    expectNoOp(execute(doc, 'sweep_profile', { pathIds: [a], radius: 5 }), doc, 'SWG_PATH_INVALID');
    expectNoOp(execute(doc, 'sweep_profile', { pathIds: [a, b], path: BAR, radius: 5 }), doc, 'exactly one of path');
  });
  it('is pure', () => {
    const { doc, a, b } = two();
    expectPure(doc, () => execute(doc, 'sweep_profile', { pathIds: [a, b], radius: 5 }));
  });
});

describe('corners: miter (VC-SWG-38)', () => {
  const L = [
    [0, 0, 0],
    [100, 0, 0],
    [100, 100, 0],
  ];
  it('a round section keeps the closed form A (L1 + L2) = 15 707.9633', () => {
    const entity = sweep({ path: L, radius: 5, corners: 'miter' });
    expect(entity.corners).toBe('miter');
    expect(relError(volumeOf(entity), 15707.9633)).toBeLessThan(1e-6);
  });
  it('a square section meets exactly in the bisector plane: the mesh volume is side^2 (L1 + L2)', () => {
    const entity = sweep({
      path: L,
      section: [
        [-5, -5],
        [5, -5],
        [5, 5],
        [-5, 5],
      ],
      corners: 'miter',
    });
    expect(relError(volumeOf(entity), 20000)).toBeLessThan(1e-9);
  });
  it('a mitred turn of 120 degrees, with a scale law, stays watertight and positive', () => {
    const entity = sweep({
      path: [
        [0, 0, 0],
        [100, 0, 0],
        [50, 86.60254, 0],
      ],
      section: [
        [-5, -5],
        [5, -5],
        [5, 5],
        [-5, 5],
      ],
      corners: 'miter',
      scale: { type: 'linear', start: 1, end: 1 },
    });
    expect(volumeOf(entity)).toBeGreaterThan(0);
    const triangles = sweepTriangles(entity);
    expect(isWatertight(triangles)).toBe(true);
  });
  it('legs shorter than the mitre reach, turns beyond 150 degrees, smooth or closed paths and arcs are refused', () => {
    const base = { radius: 5, corners: 'miter' };
    expectNoOp(
      execute(empty, 'sweep_profile', {
        ...base,
        path: [
          [0, 0, 0],
          [4, 0, 0],
          [4, 50, 0],
        ],
      }),
      empty,
      'SWG_SELF_INTERSECTION_LOCAL',
    );
    expectNoOp(
      execute(empty, 'sweep_profile', {
        ...base,
        path: [
          [0, 0, 0],
          [100, 0, 0],
          [0, 5, 0],
        ],
      }),
      empty,
      'SWG_PATH_NOT_G1',
    );
    expect(execute(empty, 'sweep_profile', { ...base, path: L, smooth: true }).error?.code).toBe('SWG_PATH_INVALID');
    expect(execute(empty, 'sweep_profile', { ...base, path: [...L, [0, 100, 0]], closed: true }).error?.code).toBe('SWG_PATH_INVALID');
  });
  it('is pure', () => {
    expectPure(empty, () => execute(empty, 'sweep_profile', { path: L, radius: 5, corners: 'miter' }));
  });
});
