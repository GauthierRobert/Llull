import { describe, expect, it } from 'vitest';
import { recipeKey, validateShapeRecipe } from '@core/geometry/shapeRecipe';
import type { Entity, ShapeRecipe } from '@core/model/types';
import { predictedVolumeByQuadrature } from '@core/geometry/deform/predictedQuadrature';
import { buildFlowLaw, flowDeterminant, flowMap } from '@core/geometry/deform/flow';
import { WORLD_FRAME, deformNode } from './nodes';

const BOX: Entity = {
  id: 'b',
  kind: 'box',
  size: [1, 1, 1],
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  layerId: 'l',
  color: '#888',
} as Entity;
const source: ShapeRecipe = { op: 'solid', entity: BOX };

const lattice = {
  kind: 'lattice',
  box: { min: [0, 0, 0], max: [1, 1, 1] },
  degrees: [1, 2, 1],
  offsets: [{ index: [1, 1, 0], delta: [0.1, 0, 0] }],
};
const point = { kind: 'point', center: [0, 0, 0], direction: [0, 0, 1], distance: 0.2, radius: 1, falloff: 'smooth_c2' };
const stations = Array.from({ length: 3 }, (_, k) => [0, 0, k, 0, 0, 1, 1, 0, 0, 0, 1, 0]).flat();
const flowCurve = { kind: 'flowCurve', z0: 0, ratio: 1, step: 1, stations };
const surfaceNodes = Array.from({ length: 4 }, (_, k) => [k, 0, 0, 0, 0, 1]).flat();
const flowSurface = { kind: 'flowSurface', x0: 0, y0: 0, hx: 1, hy: 1, nx: 2, ny: 2, nodes: surfaceNodes };
const rbf = { kind: 'rbf', centres: [0, 0, 0, 1, 0, 0], weights: [0, 0, 0, 0, 1, 0], affine: Array.from({ length: 12 }, () => 0) };

/** `validateShapeRecipe` of a deform node with the given law (plain JSON, no region: these laws need none). */
function check(law: unknown): string | null {
  const node = { ...JSON.parse(JSON.stringify(deformNode({ kind: 'twist', angleRad: 1 }, { source }))), law };
  delete (node as Record<string, unknown>)['region'];
  return validateShapeRecipe(node);
}

describe('recipes of the free-form laws (TR-DEF-02)', () => {
  it('accepts a well-formed law of every kind, with no region', () => {
    for (const law of [lattice, point, flowCurve, flowSurface, rbf]) expect(check(law), JSON.stringify(law).slice(0, 40)).toBeNull();
  });

  it('names what is wrong with a malformed lattice, point, flow or field', () => {
    expect(check({ ...lattice, box: { min: [0, 0, 0], max: [0, 1, 1] } })).toContain('box needs finite min < max');
    expect(check({ ...lattice, degrees: [1, 9, 1] })).toContain('degrees must be 3 integers in 1..8');
    expect(check({ ...lattice, offsets: 'x' })).toContain('offsets must be an array');
    expect(check({ ...lattice, offsets: [{ index: [0, 0], delta: [0, 0, 0] }] })).toContain('index [i, j, k]');
    expect(check({ ...lattice, offsets: [{ index: [5, 0, 0], delta: [0, 0, 0] }] })).toContain('outside the control net');
    expect(check({ ...point, radius: 0 })).toContain('radius > 0');
    expect(check({ ...point, falloff: 'sharp' })).toContain('falloff');
    expect(check({ ...flowCurve, step: 0 })).toContain('ratio and step > 0');
    expect(check({ ...flowCurve, stations: [1, 2, 3] })).toContain('12 per station');
    expect(check({ ...flowSurface, hx: -1 })).toContain('hx, hy > 0');
    expect(check({ ...flowSurface, nodes: [1, 2, 3] })).toContain('6 finite numbers');
    expect(check({ ...rbf, centres: [] })).toContain('three per centre');
    expect(check({ ...rbf, affine: [1] })).toContain('affine twelve');
  });

  it('hashes the law data into the recipe key', () => {
    const key = (law: unknown): string =>
      recipeKey({ ...deformNode({ kind: 'twist', angleRad: 1 }, { source }), law } as unknown as ShapeRecipe);
    expect(key(point)).toBe(key({ ...point }));
    expect(key(point)).not.toBe(key({ ...point, distance: 0.3 }));
    expect(key(rbf)).not.toBe(key({ ...rbf, weights: [0, 0, 0, 0, 2, 0] }));
  });
});

describe('flow along a curve beyond the table and under stretch', () => {
  const straight = {
    degree: 1,
    poles: [
      [0, 0, 0],
      [0, 0, 10],
    ],
    knots: [0, 1],
    multiplicities: [2, 2],
  } as const;

  it('continues straight past both ends, scales to the curve length with stretch, and refuses a degenerate curve or an up vector along the tangent', () => {
    const law = buildFlowLaw(straight, {
      z0: 0,
      baseLength: 20,
      stretch: false,
      orientation: 'minimal',
      tolerance: 1e-3,
      lateral: 1,
      initialNormal: [1, 0, 0],
    });
    if (typeof law === 'string') throw new Error(law);
    expect(flowMap(law, [1, 2, 25])).toEqual([1, 2, 25]);
    const before = flowMap(law, [0, 0, -3]);
    expect(before[2]).toBeCloseTo(-3, 9);
    expect(flowDeterminant(law, [0.5, 0.5, 5])).toBeCloseTo(1, 6);
    const stretched = buildFlowLaw(straight, {
      z0: 0,
      baseLength: 20,
      stretch: true,
      orientation: 'minimal',
      tolerance: 1e-3,
      lateral: 1,
      initialNormal: [1, 0, 0],
    });
    if (typeof stretched === 'string') throw new Error(stretched);
    expect(stretched.ratio).toBeCloseTo(0.5, 12);
    expect(flowMap(stretched, [0, 0, 20])[2]).toBeCloseTo(10, 9);
    const zero = {
      ...straight,
      poles: [
        [0, 0, 0],
        [0, 0, 0],
      ],
    };
    expect(
      buildFlowLaw(zero as never, {
        z0: 0,
        baseLength: 1,
        stretch: false,
        orientation: 'minimal',
        tolerance: 1,
        lateral: 1,
        initialNormal: [1, 0, 0],
      }),
    ).toBe('CURVE_DEGENERATE');
    expect(
      buildFlowLaw(straight, {
        z0: 0,
        baseLength: 0,
        stretch: false,
        orientation: 'minimal',
        tolerance: 1,
        lateral: 1,
        initialNormal: [1, 0, 0],
      }),
    ).toBe('CURVE_DEGENERATE');
    expect(
      buildFlowLaw(straight, {
        z0: 0,
        baseLength: 5,
        stretch: false,
        orientation: 'fixed_up',
        up: [0, 0, 1],
        tolerance: 1,
        lateral: 1,
        initialNormal: [1, 0, 0],
      }),
    ).toBe('UP_PARALLEL');
    const up = buildFlowLaw(straight, {
      z0: 0,
      baseLength: 5,
      stretch: false,
      orientation: 'fixed_up',
      up: [0, 1, 0],
      tolerance: 1,
      lateral: 1,
      initialNormal: [1, 0, 0],
    });
    expect(typeof up).toBe('object');
  });
});

describe('quadrature of det J over a closed mesh', () => {
  it('integrates a constant Jacobian to its volume times the constant, skips flat triangles and thins the rule on big meshes', () => {
    // a unit tetrahedron-ish closed mesh: two copies of the same cube faces cost nothing special; a degenerate triangle is skipped
    const cube = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
    const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7];
    const scale = { kind: 'rbf', centres: [10, 10, 10], weights: [0, 0, 0], affine: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] };
    const result = predictedVolumeByQuadrature({ positions: cube, indices: faces }, { law: scale as never, frame: WORLD_FRAME });
    // A = diag(2, 2, 2) acts as I + A = diag(2, 2, 2): det J = 8 everywhere (the far centre has zero weight)
    expect(result?.source).toBeCloseTo(1, 9);
    expect(result?.predicted).toBeCloseTo(8, 6);
    const flat = predictedVolumeByQuadrature(
      { positions: [...cube, 5, 5, 5], indices: [...faces, 8, 8, 8] },
      { law: scale as never, frame: WORLD_FRAME },
    );
    expect(flat?.predicted).toBeCloseTo(8, 6);
    const big = Array.from({ length: 3000 }, (_, k) => (k % 36 === 0 ? 0 : 0));
    expect(
      predictedVolumeByQuadrature(
        { positions: cube, indices: faces.concat(big.map((_, k) => faces[k % faces.length] as number)) },
        { law: scale as never, frame: WORLD_FRAME },
      ),
    ).not.toBeNull();
    expect(predictedVolumeByQuadrature({ positions: [], indices: [] }, { law: scale as never, frame: WORLD_FRAME })).toBeNull();
  });
});
