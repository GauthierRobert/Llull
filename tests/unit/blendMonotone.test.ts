/**
 * DES-6c: the monotone radius law (C1 cubic through the stations, never below the smallest one), its closed forms, the steepness refusal, the OCP export
 * nodes, and `fillet_edge` over a scripted kernel (the native values are asserted in server/tests/nativeBlendMonotone.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type EdgeRadius, type ShapeRecipe } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { lawNodes, radiusAt, resolveLaw, reverseLaw } from '@core/geometry/blend/law';
import { monotoneRadius, monotoneSlopes } from '@core/geometry/blend/monotone';
import { exactParameters } from '@core/geometry/blend/blendInfo';
import { scriptedKernel } from '../helpers/blendKernel';
import { expectNoOp } from '../helpers/expectNoOp';

afterEach(() => setGeometryKernel(null));

const stations = (...pairs: Array<[number, number]>): Array<{ t: number; size: number }> => pairs.map(([t, size]) => ({ t, size }));

describe('monotone slopes and values', () => {
  it('slopes: zero at both ends and at a local extremum, the weighted harmonic mean of the secants elsewhere (closed form)', () => {
    const [a, b, c, d] = [
      stations([0, 1], [0.25, 2], [0.5, 3], [1, 3.5]),
      stations([0, 1], [0.5, 3], [1, 2]),
      stations([0, 2], [0.5, 1], [1, 2]),
      stations([0, 1], [1, 2]),
    ];
    expect(monotoneSlopes(d)).toEqual([0, 0]);
    expect(monotoneSlopes(b)).toEqual([0, 0, 0]);
    expect(monotoneSlopes(c)).toEqual([0, 0, 0]);
    // a: widths 0.25, 0.25, 0.5; secants 4, 4, 1; slope at 0.25: both secants 4 -> 4; at 0.5: w1 = 2 * 0.5 + 0.25, w2 = 0.5 + 2 * 0.25 -> (w1 + w2) / (w1 / 4 + w2 / 1)
    const [w1, w2] = [2 * 0.5 + 0.25, 0.5 + 2 * 0.25];
    const slopes = monotoneSlopes(a);
    expect(slopes[0]).toBe(0);
    expect(slopes[1]).toBeCloseTo(4, 12);
    expect(slopes[2]).toBeCloseTo((w1 + w2) / (w1 / 4 + w2 / 1), 12);
    expect(slopes[3]).toBe(0);
  });

  it('the curve passes through every station, is C1 across them, and stays between the radii of the two stations around it (never below the smallest station)', () => {
    const points = stations([0, 1], [0.2, 1.1], [0.45, 2.5], [0.5, 2.6], [0.8, 0.9], [1, 1.2]);
    const slopes = monotoneSlopes(points);
    for (const point of points) expect(monotoneRadius(points, point.t)).toBeCloseTo(point.size, 12);
    const h = 1e-6;
    for (const point of points.slice(1, -1)) {
      const left = (monotoneRadius(points, point.t) - monotoneRadius(points, point.t - h)) / h;
      const right = (monotoneRadius(points, point.t + h) - monotoneRadius(points, point.t)) / h;
      expect(left).toBeCloseTo(right, 3);
    }
    const smallest = Math.min(...points.map((point) => point.size));
    let lowest = Infinity;
    for (let k = 0; k <= 4000; k++) {
      const t = k / 4000;
      const value = monotoneRadius(points, t, slopes);
      lowest = Math.min(lowest, value);
      const at = points.findIndex((point) => point.t >= t);
      const [from, to] = [
        points[Math.max(at - 1, 0)] as { t: number; size: number },
        points[Math.max(at, 0)] as { t: number; size: number },
      ];
      expect(value).toBeGreaterThanOrEqual(Math.min(from.size, to.size) - 1e-12);
      expect(value).toBeLessThanOrEqual(Math.max(from.size, to.size) + 1e-12);
    }
    expect(lowest).toBeGreaterThanOrEqual(smallest - 1e-12);
  });

  it('two stations make one cubic with zero end slopes: the smoothstep, whose integral is the mean of the two radii (closed form)', () => {
    const points = stations([0, 1], [1, 3]);
    expect(monotoneRadius(points, 0.5)).toBeCloseTo(2, 12);
    let integral = 0;
    const n = 20000;
    for (let k = 0; k < n; k++) integral += monotoneRadius(points, (k + 0.5) / n) / n;
    expect(integral).toBeCloseTo(2, 8);
  });
});

describe('the law resolver and its readers', () => {
  it('keeps "monotone" on a law that varies (a start and an end alone included: one exact cubic), drops it on a constant law', () => {
    expect(resolveLaw({ size: 1, sizeEnd: 2, interpolation: 'monotone' })).toEqual({ size: 1, sizeEnd: 2, interpolation: 'monotone' });
    expect(resolveLaw({ size: 1, interpolation: 'monotone' })).toEqual({ size: 1 });
    expect(resolveLaw({ size: 1, sizeEnd: 2, sizes: [{ t: 0.5, size: 3 }], interpolation: 'monotone' })).toEqual({
      size: 1,
      sizeEnd: 2,
      sizes: [{ t: 0.5, size: 3 }],
      interpolation: 'monotone',
    });
    expect(resolveLaw({ law: { expression: '1 + t', samples: 5 }, interpolation: 'monotone' })).toMatchObject({
      interpolation: 'monotone',
    });
  });

  it('radiusAt reads the exact curve (what check_blends compares everywhere); exactParameters says "all"; reversing mirrors the stations', () => {
    const law: EdgeRadius = {
      size: 1,
      sizeEnd: 1.2,
      sizes: [
        { t: 0.3, size: 2 },
        { t: 0.7, size: 1.4 },
      ],
      interpolation: 'monotone',
    };
    const points = stations([0, 1], [0.3, 2], [0.7, 1.4], [1, 1.2]);
    for (const t of [0, 0.1, 0.3, 0.55, 0.9, 1]) expect(radiusAt(law, t)).toBeCloseTo(monotoneRadius(points, t), 12);
    expect(exactParameters(law)).toBe('all');
    const back = reverseLaw(law);
    for (const t of [0, 0.2, 0.45, 0.8, 1]) expect(radiusAt(back, 1 - t)).toBeCloseTo(radiusAt(law, t), 12);
  });

  it('the OCP export nodes sit on the exact curve and include every station', () => {
    const law: EdgeRadius = {
      size: 1,
      sizeEnd: 1.2,
      sizes: [
        { t: 0.3, size: 2 },
        { t: 0.7, size: 1.4 },
      ],
      interpolation: 'monotone',
    };
    const nodes = lawNodes(law, 20);
    expect(nodes).not.toBeNull();
    for (const [t, size] of nodes ?? []) expect(size).toBeCloseTo(radiusAt(law, t), 12);
    for (const t of [0, 0.3, 0.7, 1]) expect((nodes ?? []).some(([at]) => at === t)).toBe(true);
    expect((nodes ?? []).length).toBe(3 * 13 + 1);
  });
});

describe('fillet_edge with a monotone law over a scripted kernel', () => {
  const context = (kernel: GeometryKernel): ReturnType<typeof defaultContext> => ({ ...defaultContext(), kernel });
  function box(): { doc: CadDocument; id: string } {
    const made = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    return { doc: made.document, id: made.affected[0] as string };
  }
  const lastFillet = (kernel: ReturnType<typeof scriptedKernel>): Extract<ShapeRecipe, { op: 'fillet' }> | undefined =>
    [...kernel.recipes].reverse().find((recipe): recipe is Extract<ShapeRecipe, { op: 'fillet' }> => recipe.op === 'fillet');

  it('a monotone law reaches the kernel as monotone, a steep one too (the native probe in nativeBlendMonotone.test.ts builds slopes up to 50 exactly: no steepness refusal)', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const ok = execute(
      doc,
      'fillet_edge',
      { id, edges: [{ index: 0, size: 1, sizeEnd: 1.2, sizes: [{ t: 0.4, size: 2 }], interpolation: 'monotone' }] },
      context(kernel),
    );
    expect(ok.error, ok.summary).toBeUndefined();
    expect(lastFillet(kernel)).toMatchObject({
      radii: [{ size: 1, sizeEnd: 1.2, sizes: [{ t: 0.4, size: 2 }], interpolation: 'monotone' }],
    });
    expect(ok.summary).toContain('monotone control point(s)');
    const steep = execute(
      doc,
      'fillet_edge',
      { id, edges: [{ index: 0, size: 1, sizeEnd: 30, sizes: [{ t: 0.5, size: 15 }], interpolation: 'monotone' }] },
      context(kernel),
    );
    expect(steep.error, steep.summary).toBeUndefined();
  });

  it('stations out of order and a radius <= 0 stay BLD_LAW_INVALID with the path of the value', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const order = execute(
      doc,
      'fillet_edge',
      {
        id,
        edges: [
          {
            index: 0,
            size: 1,
            sizes: [
              { t: 0.6, size: 2 },
              { t: 0.4, size: 2 },
            ],
            interpolation: 'monotone',
          },
        ],
      },
      context(kernel),
    );
    expect(order.error).toMatchObject({ code: 'BLD_LAW_INVALID', paths: ['edges[0].sizes[1].t'] });
    const negative = execute(
      doc,
      'fillet_edge',
      { id, edges: [{ index: 0, size: 1, sizes: [{ t: 0.5, size: -1 }], interpolation: 'monotone' }] },
      context(kernel),
    );
    expect(negative.error).toMatchObject({ code: 'BLD_LAW_INVALID', paths: ['edges[0].sizes[0].size'] });
    expect(kernel.recipes.some((recipe) => recipe.op === 'fillet')).toBe(false);
  });

  it('a monotone law at a setback corner is BLD_CORNER_UNSUPPORTED (like every smooth or multi-station law), and nothing changes', () => {
    const kernel = scriptedKernel();
    const { doc, id } = box();
    const corner = execute(
      doc,
      'fillet_edge',
      {
        id,
        edges: [{ index: 0, size: 1, sizeEnd: 1.2, sizes: [{ t: 0.4, size: 2 }], interpolation: 'monotone' }],
        corners: [{ near: [10, 5, 2.5], type: 'setback', setback: 2 }],
      },
      context(kernel),
    );
    expectNoOp(corner, doc, 'BLD_CORNER_UNSUPPORTED');
    expect(kernel.recipes.some((recipe) => recipe.op === 'fillet')).toBe(false);
  });
});
