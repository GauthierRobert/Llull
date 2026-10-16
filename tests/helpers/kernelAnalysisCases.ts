/** The PHY-21 kernel cases (VC-FPR-01…05) run against any kernel: Manifold in `tests/unit`, OCC in `server/tests`. */
import { expect, it } from 'vitest';
import type { GeometryKernel, ShapeAnalysis, ShapeDistance, ShapeHandle } from '@core/geometry/kernel';
import type { Entity, ShapeRecipe, Vec3 } from '@core/model/types';

const common = { layerId: 'layer-default', color: '#888888', rotation: [0, 0, 0] as Vec3 };

export const cube = (id: string, position: Vec3, side: number): Entity =>
  ({ id, kind: 'box', position, size: [side, side, side], ...common }) as Entity;

const leaf = (entity: Entity): ShapeRecipe => ({ op: 'solid', entity });

const shapeOf = (kernel: GeometryKernel, recipe: ShapeRecipe): ShapeHandle => {
  const shape = kernel.evaluate(recipe);
  expect(shape).not.toBeNull();
  return shape as ShapeHandle;
};

/** Volume of `a` ∩ `b` through the recipe path (TR-FPR-03); 0 when the kernel returns nothing. */
function overlapVolume(kernel: GeometryKernel, a: Entity, b: Entity): number {
  const shape = kernel.evaluate({ op: 'boolean', boolean: 'intersect', a: leaf(a), b: leaf(b) });
  return shape === null ? 0 : (kernel.analyze?.(shape)?.volume ?? 0);
}

export function kernelAnalysisCases(getKernel: () => GeometryKernel, label: string): void {
  const analyzed = (entity: Entity): ShapeAnalysis => {
    const analysis = getKernel().analyze?.(shapeOf(getKernel(), leaf(entity)));
    expect(analysis).toBeTruthy();
    return analysis as ShapeAnalysis;
  };
  const distanceOf = (a: Entity, b: Entity, max: number): ShapeDistance => {
    const kernel = getKernel();
    const result = kernel.distance?.(shapeOf(kernel, leaf(a)), shapeOf(kernel, leaf(b)), max);
    expect(result).toBeTruthy();
    return result as ShapeDistance;
  };

  it(`${label}: analyze reports a valid closed single-lump cube`, () => {
    const analysis = analyzed(cube('a', [0, 0, 0], 20));
    expect(analysis.valid).toBe(true);
    expect(analysis.closed).toBe(true);
    expect(analysis.volume).toBeCloseTo(8000, 3);
    expect(analysis.area).toBeCloseTo(2400, 3);
    expect(analysis.lumps).toHaveLength(1);
    expect(analysis.freeFaces).toBe(0);
  });

  it(`${label}: VC-FPR-01 two cubes offset 10 mm overlap by 4000 mm3`, () => {
    const [a, b] = [cube('a', [0, 0, 0], 20), cube('b', [10, 0, 0], 20)];
    expect(overlapVolume(getKernel(), a, b)).toBeCloseTo(4000, 1);
    expect(distanceOf(a, b, 1).distance).toBe(0);
  });

  it(`${label}: VC-FPR-02 cubes sharing a face touch with zero overlap`, () => {
    const [a, b] = [cube('a', [0, 0, 0], 20), cube('b', [20, 0, 0], 20)];
    expect(distanceOf(a, b, 1).distance).toBeLessThan(1e-6);
    expect(overlapVolume(getKernel(), a, b)).toBeLessThan(1e-6);
  });

  it(`${label}: VC-FPR-03 cubes 0.5 mm apart report the gap and witness points`, () => {
    const result = distanceOf(cube('a', [0, 0, 0], 20), cube('b', [20.5, 0, 0], 20), 1);
    expect(result.distance).toBeCloseTo(0.5, 6);
    expect(result.inside).toBe(false);
    expect(Math.abs(result.pointB[0] - result.pointA[0])).toBeCloseTo(0.5, 6);
  });

  it(`${label}: a pair beyond the search length is not reported as close`, () => {
    expect(distanceOf(cube('a', [0, 0, 0], 20), cube('b', [100, 0, 0], 20), 1).distance).toBeGreaterThanOrEqual(1);
  });

  it(`${label}: VC-FPR-04 a cube nested in a larger cube is inside`, () => {
    const [outer, inner] = [cube('a', [0, 0, 0], 30), cube('b', [0, 0, 0], 10)];
    expect(distanceOf(outer, inner, 1).inside).toBe(true);
    expect(overlapVolume(getKernel(), outer, inner)).toBeCloseTo(1000, 2);
  });

  it(`${label}: VC-FPR-05 a union of two disjoint boxes has two lumps`, () => {
    const kernel = getKernel();
    const shape = shapeOf(kernel, {
      op: 'boolean',
      boolean: 'union',
      a: leaf(cube('a', [0, 0, 0], 10)),
      b: leaf(cube('b', [30, 0, 0], 10)),
    });
    const analysis = kernel.analyze?.(shape);
    expect(analysis?.lumps).toHaveLength(2);
    expect(analysis?.lumps.map((lump) => Math.round(lump.volume))).toEqual([1000, 1000]);
    expect(analysis?.volume).toBeCloseTo(2000, 2);
  });
}
