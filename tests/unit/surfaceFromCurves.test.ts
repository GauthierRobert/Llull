import { describe, it, expect } from 'vitest';
import {
  type CadDocument,
  type SubdivisionEntity,
  type Vec3,
  createEmptyDocument,
} from '@core/model/types';
import { execute } from '@core/commands/registry';
import { entityBounds } from '@core/geometry/bounds';
import { polylineAt } from '@core/geometry/boundaryPatch';
import { cageProblem } from '@core/geometry/subdivision';
import { expectNoOp } from '../helpers/expectNoOp';

const empty = createEmptyDocument();

const run = (doc: CadDocument, params: object): ReturnType<typeof execute> =>
  execute(doc, 'surface_from_curves', params as Record<string, unknown>);

function created(doc: CadDocument, params: object): { doc: CadDocument; e: SubdivisionEntity } {
  const result = run(doc, params);
  expect(result.affected, result.summary).toHaveLength(1);
  return {
    doc: result.document,
    e: result.document.entities[result.affected[0] as string] as SubdivisionEntity,
  };
}

const volumeOf = (doc: CadDocument, id: string): number =>
  (execute(doc, 'measure_volume', { entityId: id }).data as { volume: number }).volume;

/** A 10 × 10 square loop, given out of order and partly reversed. */
const square: Vec3[][] = [
  [
    [0, 0, 0],
    [10, 0, 0],
  ],
  [
    [0, 10, 0],
    [10, 10, 0],
  ],
  [
    [10, 10, 0],
    [10, 0, 0],
  ],
  [
    [0, 10, 0],
    [0, 0, 0],
  ],
];

describe('boundary patch geometry', () => {
  it('walks a polyline by arc length', () => {
    const line: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 3, 0],
    ];
    expect(polylineAt(line, 0)).toEqual([0, 0, 0]);
    expect(polylineAt(line, 0.5)).toEqual([1, 1, 0]);
    expect(polylineAt(line, 2)).toEqual([1, 3, 0]);
  });
});

describe('surface_from_curves', () => {
  it('spans a closed loop of 4 curves (any order / direction) with a sharp, flat slab', () => {
    const result = run(empty, { curves: square, thickness: 1, cells: [4, 3] });
    expect(result.summary).toContain('from 4 curves, 1 thick (40-vertex');
    const e = result.document.entities[result.affected[0] as string] as SubdivisionEntity;
    expect(cageProblem(e)).toBeNull();
    expect(volumeOf(result.document, e.id)).toBeCloseTo(100, 6);
    const b = entityBounds(e);
    expect(b.min).toEqual([expect.closeTo(0, 6), expect.closeTo(0, 6), expect.closeTo(-1, 6)]);
    expect(b.max).toEqual([expect.closeTo(10, 6), expect.closeTo(10, 6), expect.closeTo(0, 6)]);
    expect((result.data as { vertexCount: number }).vertexCount).toBe(40);
  });

  it('thickens the other way when flipped', () => {
    const { e } = created(empty, { curves: square, thickness: 2, flip: true, name: 'panel' });
    const b = entityBounds(e);
    expect(b.min[2]).toBeCloseTo(0, 6);
    expect(b.max[2]).toBeCloseTo(2, 6);
    expect(e.name).toBe('panel');
  });

  it('follows bowed curves (a hood) and stays closed', () => {
    const bow = (y: number): Vec3[] => [
      [0, y, 0],
      [5, y, 3],
      [10, y, 0],
    ];
    const { doc, e } = created(empty, {
      curves: [bow(0), bow(8)],
      thickness: 0.5,
      cells: [8, 4],
      levels: 3,
    });
    expect(cageProblem(e)).toBeNull();
    const b = entityBounds(e);
    expect(b.max[2]).toBeGreaterThan(2.5);
    expect(b.max[2]).toBeLessThan(3.2);
    expect(volumeOf(doc, e.id)).toBeGreaterThan(0.5 * 10 * 8);
  });

  it('takes 2D sketch curves by id', () => {
    let doc = empty;
    const ids: string[] = [];
    for (const [start, end] of [
      [
        [0, 0],
        [6, 0],
      ],
      [
        [6, 0],
        [6, 4],
      ],
      [
        [6, 4],
        [0, 4],
      ],
      [
        [0, 4],
        [0, 0],
      ],
    ]) {
      const drawn = execute(doc, 'draw_line', { start, end });
      doc = drawn.document;
      ids.push(drawn.affected[0] as string);
    }
    const { doc: withPatch, e } = created(doc, { curveIds: ids, thickness: 1, cells: [3, 2] });
    expect(volumeOf(withPatch, e.id)).toBeCloseTo(24, 6);
  });

  it.each([
    [{ curves: square, thickness: 0 }, 'thickness must be > 0'],
    [{ curves: square, thickness: 1, cells: [0, 4] }, 'cells must be integers'],
    [{ thickness: 1 }, 'exactly one of curves or curveIds'],
    [{ curves: square, curveIds: ['a'], thickness: 1 }, 'exactly one of'],
    [{ curves: square.slice(0, 3), thickness: 1 }, 'give 2 or 4 curves'],
    [{ curves: [[[0, 0, 0]], [[1, 1, 1]]], thickness: 1 }, 'at least 2 points'],
    [{ curveIds: ['nope', 'nada'], thickness: 1 }, 'no entity "nope"'],
    [
      {
        curves: [
          ...square.slice(0, 3),
          [
            [0, 10, 0],
            [0, 1, 0],
          ],
        ],
        thickness: 1,
      },
      'do not form a closed loop',
    ],
    [
      {
        curves: [
          [
            [0, 0, 0],
            [10, 0, 0],
          ],
          [
            [0, 0, 0],
            [0, 0, 5],
          ],
        ],
        thickness: 1,
      },
      'touch at their start',
    ],
    [
      {
        curves: [
          [
            [0, 0, 0],
            [10, 0, 0],
          ],
          [
            [20, 0, 0],
            [30, 0, 0],
          ],
        ],
        thickness: 1,
        cells: [2, 2],
      },
      'degenerate',
    ],
    [{ curves: square, thickness: 1, levels: 6 }, 'levels must be an integer'],
  ])('rejects bad input (%#)', (params, text) => {
    expectNoOp(run(empty, params), empty, text);
  });

  it('rejects a duplicate explicit id and is pure', () => {
    const { doc } = created(empty, { curves: square, thickness: 1, id: 'P' });
    expectNoOp(run(doc, { curves: square, thickness: 1, id: 'P' }), doc, 'already exists');
    const before = structuredClone(doc);
    run(doc, { curves: square, thickness: 1 });
    expect(doc).toEqual(before);
  });
});
