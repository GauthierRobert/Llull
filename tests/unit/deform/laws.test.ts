import { describe, expect, it } from 'vitest';
import { affineWorld, localDeterminant, mapLocal, warpOf } from '@core/geometry/deform/laws';
import { resolveFrame, toLocal, toWorld } from '@core/geometry/deform/frame';
import { rampAt } from '@core/geometry/deform/region';
import { unmapLocal } from '@core/geometry/deform/inverse';
import { storedChordError } from '@core/geometry/deform/storedError';
import type { DeformLaw, DeformRegion } from '@core/model/deform';
import type { Vec3 } from '@core/model/types';
import { packData } from './packPaths';
import { IDENTITY_ROWS, deformNode, region } from './nodes';

interface PointVectors {
  readonly laws: Record<string, { params: Record<string, unknown>; points: Array<{ in: Vec3; out: Vec3; det: number }> }>;
}

const vectors = packData<PointVectors>('point_vectors.json');

function lawOf(name: string): { law: DeformLaw; region: DeformRegion } {
  const params = vectors.laws[name]?.params as Record<string, number | boolean | string | number[]>;
  const span = region(
    (params['z0'] as number | undefined) ?? 0,
    (params['z1'] as number | undefined) ?? 1,
    (params['falloff'] as DeformRegion['falloff'] | undefined) ?? 'linear',
  );
  switch (name) {
    case 'twist':
    case 'twist_smooth':
      return { law: { kind: 'twist', angleRad: params['angleRad'] as number }, region: span };
    case 'taper':
    case 'taper_flat':
      return { law: { kind: 'taper', scaleEnd: params['scaleEnd'] as number, flat: params['flat'] === true }, region: span };
    case 'bend':
      return { law: { kind: 'bend', radius: params['radius'] as number, symmetric: false }, region: span };
    case 'stretch':
      return { law: { kind: 'stretch', factor: params['factor'] as number }, region: span };
    default: {
      const [sx = 1, sy = 1, sz = 1] = params['factors'] as number[];
      return {
        law: {
          kind: 'affine',
          matrix: [
            [sx, 0, 0],
            [0, sy, 0],
            [0, 0, sz],
          ],
          translation: [0, 0, 0],
        },
        region: span,
      };
    }
  }
}

describe('deformation laws against the validation pack (VC-DEF-30)', () => {
  const names = ['twist', 'twist_smooth', 'taper', 'taper_flat', 'bend', 'stretch', 'scale_nonuniform'];
  it.each(names)('%s maps every golden point within 1e-9 and matches det J', (name) => {
    const { law, region: span } = lawOf(name);
    const warp = warpOf(deformNode(law, { region: span }));
    expect(warp).not.toBeNull();
    for (const point of vectors.laws[name]?.points ?? []) {
      const image = warp?.point(point.in) ?? [NaN, NaN, NaN];
      image.forEach((value, axis) => expect(Math.abs(value - (point.out[axis] as number))).toBeLessThan(1e-9));
      const onKink = [span.start, span.end].some((z) => Math.abs(point.in[2] - z) < 1e-9);
      if (!onKink) expect(Math.abs((warp?.determinant(point.in) ?? NaN) - point.det)).toBeLessThan(1e-6);
    }
  });

  it('Jacobian determinants agree with central differences away from kinks', () => {
    for (const name of ['twist_smooth', 'taper', 'taper_flat', 'bend']) {
      const { law, region: span } = lawOf(name);
      for (const q of [
        [2, 1, 30],
        [-3, 2, 50],
        [1, -2, 70],
      ] as Vec3[]) {
        const h = 1e-5;
        const column = (axis: number): Vec3 => {
          const plus: number[] = [...q];
          const minus: number[] = [...q];
          plus[axis] = (q[axis] as number) + h;
          minus[axis] = (q[axis] as number) - h;
          const [p, m] = [mapLocal(law, span, plus as unknown as Vec3), mapLocal(law, span, minus as unknown as Vec3)];
          return [(p[0] - m[0]) / (2 * h), (p[1] - m[1]) / (2 * h), (p[2] - m[2]) / (2 * h)];
        };
        const [a, b, c] = [column(0), column(1), column(2)];
        const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
        expect(Math.abs(det - localDeterminant(law, span, q))).toBeLessThan(1e-6);
      }
    }
  });

  it('symmetric bend keeps the region middle in place and the ends symmetric', () => {
    const span = region(0, 78.53981633974483);
    const law: DeformLaw = { kind: 'bend', radius: 50, symmetric: true };
    const middle = mapLocal(law, span, [0, 0, span.end / 2]);
    expect(middle[1]).toBeCloseTo(0, 9);
    expect(middle[2]).toBeCloseTo(span.end / 2, 9);
    const [low, high] = [mapLocal(law, span, [0, 0, 0]), mapLocal(law, span, [0, 0, span.end])];
    expect(low[1]).toBeCloseTo(high[1], 9);
    expect(low[2] + high[2]).toBeCloseTo(span.end, 9);
  });

  it('ramps: zero below, one past the end (rigid), smooth has zero slope at both ends', () => {
    const span = region(10, 20, 'smooth');
    expect(rampAt(span, 5).w).toBe(0);
    expect(rampAt(span, 25).w).toBe(1);
    expect(rampAt(span, 15)).toMatchObject({ w: 0.5, d1: 0.15 });
    expect(rampAt(region(10, 20, 'linear'), 12).w).toBeCloseTo(0.2, 12);
    expect(rampAt(region(10, 20, 'none'), 12).w).toBe(1);
  });
});

describe('frames', () => {
  it('builds an orthonormal frame and round-trips points', () => {
    const frame = resolveFrame({ origin: [1, 2, 3], axis: [0, 0, 2], reference: [1, 0, 5] });
    if (frame === null) throw new Error('frame');
    expect(frame.x).toEqual([1, 0, 0]);
    expect(frame.y).toEqual([0, 1, 0]);
    const p: Vec3 = [4, -5, 6];
    toWorld(frame, toLocal(frame, p)).forEach((v, i) => expect(v).toBeCloseTo(p[i] as number, 12));
  });
  it.each([
    ['zero axis', { origin: [0, 0, 0], axis: [0, 0, 0], reference: [1, 0, 0] }],
    ['reference parallel to the axis', { origin: [0, 0, 0], axis: [0, 0, 1], reference: [0, 0, 3] }],
    ['zero reference', { origin: [0, 0, 0], axis: [0, 0, 1], reference: [0, 0, 0] }],
    ['non-finite', { origin: [NaN, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] }],
  ] as const)('refuses %s', (_label, frame) => {
    expect(resolveFrame(frame)).toBeNull();
    expect(warpOf({ law: { kind: 'twist', angleRad: 1 }, frame, region: region(0, 1) })).toBeNull();
  });
});

describe('affineWorld', () => {
  it('composes the frame with the local matrix and agrees with the point map', () => {
    const node = deformNode(
      {
        kind: 'affine',
        matrix: [
          [2, 0, 0],
          [0, 1, 0],
          [0, 0, 3],
        ],
        translation: [1, 0, 0],
      },
      { frame: { origin: [1, 1, 0], axis: [1, 0, 0], reference: [0, 1, 0] } },
    );
    const map = affineWorld(node);
    if (map === null) throw new Error('affine');
    // local x = world y (scaled by 2), local z = world x (scaled by 3)
    expect(map.matrix).toEqual([
      [3, 0, 0],
      [0, 2, 0],
      [0, 0, 1],
    ]);
    const p: Vec3 = [3, 2, 5];
    const direct = warpOf(node)?.point(p) ?? [NaN, NaN, NaN];
    direct.forEach((v, r) => {
      const row = map.matrix[r] as Vec3;
      expect(v).toBeCloseTo(row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + (map.translation[r] as number), 12);
    });
  });
  it('is null for another law or a degenerate frame', () => {
    expect(affineWorld(deformNode({ kind: 'twist', angleRad: 1 }))).toBeNull();
    const degenerate = { origin: [0, 0, 0], axis: [0, 0, 0], reference: [1, 0, 0] } as const;
    expect(affineWorld(deformNode({ kind: 'affine', matrix: IDENTITY_ROWS, translation: [0, 0, 0] }, { frame: degenerate }))).toBeNull();
  });
});

describe('inverse laws and the stored-mesh chord error', () => {
  const laws: Array<[string, DeformLaw, DeformRegion]> = [
    ['twist smooth', { kind: 'twist', angleRad: 2 }, region(10, 60, 'smooth')],
    ['taper', { kind: 'taper', scaleEnd: 0.4, flat: false }, region(10, 60, 'linear')],
    ['taper flat', { kind: 'taper', scaleEnd: 2, flat: true }, region(10, 60, 'smooth')],
    ['stretch', { kind: 'stretch', factor: 1.7 }, region(10, 60, 'none')],
    ['bend', { kind: 'bend', radius: 30, symmetric: false }, region(10, 70)],
    ['bend symmetric', { kind: 'bend', radius: 30, symmetric: true }, region(10, 70)],
  ];
  it.each(laws)('%s: unmap(map(q)) = q below, inside and past the region', (_name, law, span) => {
    for (const q of [
      [3, 2, 0],
      [3, -4, 10],
      [-2, 5, 35],
      [4, 1, 60],
      [1, -3, 90],
    ] as Vec3[]) {
      const back = unmapLocal(law, span, mapLocal(law, span, q));
      back?.forEach((value, axis) => expect(value).toBeCloseTo(q[axis] as number, 8));
    }
  });
  it('the affine law has no pointwise inverse here and no chord error', () => {
    expect(unmapLocal({ kind: 'affine', matrix: IDENTITY_ROWS, translation: [0, 0, 0] }, region(0, 1), [1, 2, 3])).toBeNull();
    expect(
      storedChordError(
        { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
        deformNode({ kind: 'affine', matrix: IDENTITY_ROWS, translation: [0, 0, 0] }),
      ),
    ).toBe(0);
  });
  it('a stored twisted edge that is a straight chord of a long twist deviates; a refined one stays within tolerance', () => {
    const node = deformNode({ kind: 'twist', angleRad: Math.PI }, { region: region(0, 10, 'linear') });
    const coarse = { positions: [5, 0, 0, -5, 0, 10, 5, 0, 10], indices: [0, 1, 2] };
    expect(storedChordError(coarse, node)).toBeGreaterThan(0.5);
    expect(storedChordError(coarse, { ...node, frame: { ...node.frame, axis: [0, 0, 0] } })).toBeNull();
  });
});
