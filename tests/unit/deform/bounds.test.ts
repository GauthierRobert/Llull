import { describe, expect, it } from 'vitest';
import {
  JACOBIAN_FLOOR,
  bendFibres,
  curvatureBound,
  edgeLengthFor,
  jacobianRange,
  localExtentOf,
  maxEdgeLength,
  regionCreases,
  splitHeights,
} from '@core/geometry/deform/bounds';
import { resolveFrame } from '@core/geometry/deform/frame';
import type { DeformLaw } from '@core/model/deform';
import { packData, packExpected } from './packPaths';
import { WORLD_FRAME, deformNode, region } from './nodes';

const BAR = { min: [-5, -5, 0], max: [5, 5, 100] } as const;

interface MeshBudget {
  readonly cases: Array<{ M2: number; tolerance: number; maxEdgeLength: number }>;
}

describe('closed-form bounds (VC-DEF-19 mesh budget, VC-DEF-04, VC-DEF-07, VC-DEF-09)', () => {
  const budget = packData<MeshBudget>('mesh_budget.json').cases;

  it('twist box 10x10x100, 90 deg: M2 and the refinement edge length match the pack', () => {
    const node = deformNode({ kind: 'twist', angleRad: Math.PI / 2 }, { region: region(0, 100) });
    const m2 = curvatureBound(node, BAR);
    expect(m2).toBeCloseTo(budget[0]?.M2 ?? NaN, 12);
    expect(edgeLengthFor(m2, 0.01)).toBeCloseTo(budget[0]?.maxEdgeLength ?? NaN, 4);
  });

  it('bend bar y in [-5, 5], R 50: M2 and the refinement edge length match the pack', () => {
    const node = deformNode({ kind: 'bend', radius: 50, symmetric: false }, { region: region(0, 78.54) });
    const m2 = curvatureBound(node, BAR);
    expect(m2).toBeCloseTo(budget[1]?.M2 ?? NaN, 12);
    expect(edgeLengthFor(m2, 0.01)).toBeCloseTo(budget[1]?.maxEdgeLength ?? NaN, 4);
  });

  it('the oblique term only tightens the edge length; straight-preserving maps need none', () => {
    const twist = deformNode({ kind: 'twist', angleRad: Math.PI / 2 }, { region: region(0, 100) });
    expect(maxEdgeLength(twist, BAR, 0.01)).toBeLessThan(edgeLengthFor(curvatureBound(twist, BAR), 0.01));
    const stretch = deformNode({ kind: 'stretch', factor: 2 }, { region: region(0, 100, 'none') });
    expect(maxEdgeLength(stretch, BAR, 0.01)).toBe(Infinity);
    expect(
      maxEdgeLength(
        deformNode({
          kind: 'affine',
          matrix: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          translation: [0, 0, 0],
        }),
        BAR,
        0.01,
      ),
    ).toBe(Infinity);
    const taperLinear = deformNode({ kind: 'taper', scaleEnd: 0.5, flat: false }, { region: region(0, 100) });
    expect(curvatureBound(taperLinear, BAR)).toBe(0);
    const taperSmooth = deformNode({ kind: 'taper', scaleEnd: 0.5, flat: false }, { region: region(0, 100, 'smooth') });
    expect(curvatureBound(taperSmooth, BAR)).toBeGreaterThan(0);
  });

  it('smooth ramps bound the twist rate and curvature by their maxima', () => {
    const smooth = deformNode({ kind: 'twist', angleRad: 1 }, { region: region(0, 10, 'smooth') });
    const linear = deformNode({ kind: 'twist', angleRad: 1 }, { region: region(0, 10, 'linear') });
    expect(curvatureBound(smooth, BAR)).toBeGreaterThan(curvatureBound(linear, BAR));
  });

  it('region kinks: stretch, bend and linear ramps split at both ends; smooth ramps do not', () => {
    expect(splitHeights(deformNode({ kind: 'stretch', factor: 2 }, { region: region(20, 60, 'none') }))).toEqual([20, 60]);
    expect(splitHeights(deformNode({ kind: 'bend', radius: 9, symmetric: false }, { region: region(0, 5) }))).toEqual([0, 5]);
    expect(splitHeights(deformNode({ kind: 'twist', angleRad: 1 }, { region: region(0, 5, 'linear') }))).toEqual([0, 5]);
    expect(splitHeights(deformNode({ kind: 'twist', angleRad: 1 }, { region: region(0, 5, 'smooth') }))).toEqual([]);
    expect(
      splitHeights(
        deformNode({
          kind: 'affine',
          matrix: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          translation: [0, 0, 0],
        }),
      ),
    ).toEqual([]);
  });

  it('region ends crease by atan(rate x lateral half extent): 0.1558065 rad linear, 0 smooth (VC-DEF-04)', () => {
    const expected = packExpected('VC-DEF-04').expected as { linearCreaseMaxRad: number; smoothCreaseMaxRad: number };
    const extent = { min: [-5, -5, 0], max: [5, 5, 100] } as const;
    const linear = regionCreases(deformNode({ kind: 'twist', angleRad: Math.PI / 2 }, { region: region(0, 50, 'linear') }), extent);
    expect(linear[0]?.angleRad).toBeCloseTo(expected.linearCreaseMaxRad, 6);
    expect(linear.map((crease) => crease.present)).toEqual([false, true]);
    const smooth = regionCreases(deformNode({ kind: 'twist', angleRad: Math.PI / 2 }, { region: region(0, 50, 'smooth') }), extent);
    expect(smooth[0]?.angleRad).toBe(expected.smoothCreaseMaxRad);
    const taper = regionCreases(deformNode({ kind: 'taper', scaleEnd: 0.5, flat: false }, { region: region(0, 50, 'linear') }), extent);
    expect(taper[0]?.angleRad).toBeCloseTo(Math.atan((0.5 / 50) * 5), 12);
    expect(regionCreases(deformNode({ kind: 'bend', radius: 50, symmetric: false }, { region: region(0, 50) }), extent)).toEqual([]);
  });

  it('bend fibre lengths follow (R - y) x angle (VC-DEF-07)', () => {
    const cases = packExpected('VC-DEF-07').expected as Array<{
      bar: { y0: number; y1: number; L: number };
      angleDeg: number;
      inner: number;
      outer: number;
      neutral: number;
    }>;
    for (const entry of cases) {
      const node = deformNode({ kind: 'bend', radius: 50, symmetric: false }, { region: region(0, entry.bar.L) });
      const fibres = bendFibres(node, { min: [-5, entry.bar.y0, 0], max: [5, entry.bar.y1, entry.bar.L] });
      expect(fibres?.neutral).toBeCloseTo(entry.neutral, 8);
      expect(fibres?.inner).toBeCloseTo(entry.inner, 8);
      expect(fibres?.outer).toBeCloseTo(entry.outer, 8);
    }
    expect(bendFibres(deformNode({ kind: 'twist', angleRad: 1 }, { region: region(0, 1) }), BAR)).toBeNull();
  });

  it('Jacobian ranges: bend radius below the inner side folds (min -0.25, VC-DEF-09); bend, taper, stretch, affine, twist', () => {
    const law: DeformLaw = { kind: 'bend', radius: 4, symmetric: false };
    const folded = jacobianRange(deformNode(law, { region: region(0, 6) }), BAR);
    expect(folded.min).toBeCloseTo(-0.25, 12);
    expect(folded.min).toBeLessThanOrEqual(JACOBIAN_FLOOR);
    const bend = jacobianRange(deformNode({ kind: 'bend', radius: 50, symmetric: false }, { region: region(0, 80) }), BAR);
    expect([bend.min, bend.max]).toEqual([0.9, 1.1].map((v) => expect.closeTo(v, 12)));
    const outside = jacobianRange(deformNode({ kind: 'bend', radius: 50, symmetric: false }, { region: region(200, 300) }), BAR);
    expect([outside.min, outside.max]).toEqual([1, 1]);
    const partial = jacobianRange(deformNode({ kind: 'bend', radius: 50, symmetric: false }, { region: region(20, 40) }), BAR);
    expect(partial.max).toBeCloseTo(1.1, 12);
    expect(partial.min).toBeCloseTo(0.9, 12);
    const taper = jacobianRange(deformNode({ kind: 'taper', scaleEnd: 0.5, flat: false }, { region: region(0, 100) }), BAR);
    expect(taper.min).toBeCloseTo(0.25, 12);
    expect(taper.max).toBeCloseTo(1, 12);
    expect(jacobianRange(deformNode({ kind: 'taper', scaleEnd: 3, flat: true }, { region: region(0, 100) }), BAR).max).toBeCloseTo(3, 12);
    const stretch = jacobianRange(deformNode({ kind: 'stretch', factor: 1.5 }, { region: region(20, 60, 'none') }), BAR);
    expect([stretch.min, stretch.max]).toEqual([1, 1.5]);
    const all = jacobianRange(deformNode({ kind: 'stretch', factor: 0.5 }, { region: region(-10, 200, 'none') }), BAR);
    expect([all.min, all.max]).toEqual([0.5, 0.5]);
    const mirror = jacobianRange(
      deformNode({
        kind: 'affine',
        matrix: [
          [-1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        translation: [0, 0, 0],
      }),
      BAR,
    );
    expect(mirror.min).toBe(-1);
    expect(jacobianRange(deformNode({ kind: 'twist', angleRad: 5 }, { region: region(0, 1) }), BAR)).toMatchObject({ min: 1, max: 1 });
    expect(jacobianRange({ law: { kind: 'taper', scaleEnd: 2, flat: false } }, BAR)).toMatchObject({ min: 1, max: 1 });
  });

  it('local extent is measured in the frame', () => {
    const frame = resolveFrame({ ...WORLD_FRAME, origin: [1, 0, 10] });
    if (frame === null) throw new Error('frame');
    const extent = localExtentOf(frame, [0, 0, 10, 4, 2, 30]);
    expect(extent.min).toEqual([-1, 0, 0]);
    expect(extent.max).toEqual([3, 2, 20]);
  });
});
