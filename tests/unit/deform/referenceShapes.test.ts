/** 01 DEF §17.3: the reference shapes of `analyze_deformation` compareTo that the laws of the validation pack produce (sphere, plane, elliptic cylinder, helicoid). */

import { afterEach, describe, expect, it } from 'vitest';
import { type Vec3, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { maxDeviation, referenceDistance } from '@core/geometry/deform/referenceShape';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { type KernelKind, WORLD_Z, addBox, addCylinder, dataOf, installKernel } from './harness';

const KERNELS: KernelKind[] = ['none', 'manifold'];
type Shape = Parameters<typeof referenceDistance>[0];

afterEach(() => setGeometryKernel(null));

const distanceOf = (shape: Shape): ((p: Vec3) => number) => {
  const result = referenceDistance(shape);
  if ('missing' in result) throw new Error(result.missing);
  return result;
};

describe('reference shape distances (closed forms)', () => {
  it('sphere: | |p - c| - r |', () => {
    const sphere = distanceOf({ kind: 'sphere', center: [1, 2, 3], radius: 5 });
    expect(sphere([6, 2, 3])).toBeCloseTo(0, 12);
    expect(sphere([1, 2, 3])).toBeCloseTo(5, 12);
    expect(sphere([1, 2, 11])).toBeCloseTo(3, 12);
  });

  it('plane: the distance along the normal, whatever its length', () => {
    const plane = distanceOf({ kind: 'plane', point: [0, 0, 4], normal: [0, 0, 3] });
    expect(plane([9, -7, 4])).toBeCloseTo(0, 12);
    expect(plane([0, 0, 1])).toBeCloseTo(3, 12);
    expect(plane([2, 2, 4.5])).toBeCloseTo(0.5, 12);
  });

  it('elliptic cylinder: zero on the ellipse, the offset on its principal axes, independent of the height', () => {
    const shape = distanceOf({ kind: 'ellipticCylinder', point: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0.3, 0.7], radii: [10, 5] });
    const frame = { x: [1, 0.3, 0].map((v) => v / Math.hypot(1, 0.3)), y: [-0.3, 1, 0].map((v) => v / Math.hypot(1, 0.3)) };
    const at = (u: number, v: number, z: number): Vec3 => [
      u * (frame.x[0] as number) + v * (frame.y[0] as number),
      u * (frame.x[1] as number) + v * (frame.y[1] as number),
      z,
    ];
    expect(shape(at(10, 0, 3))).toBeCloseTo(0, 9);
    expect(shape(at(0, 5, -8))).toBeCloseTo(0, 9);
    expect(shape(at(10.3, 0, 0))).toBeCloseTo(0.3, 2);
    expect(shape(at(0, 4.5, 2))).toBeCloseTo(0.5, 1);
  });

  it('helicoid: zero on the twisted plane at any height, the offset elsewhere; offset 0 is the true helicoid', () => {
    const rate = 0.1;
    const surface = (offset: number): ((p: Vec3) => number) =>
      distanceOf({ kind: 'helicoid', point: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0], rate, offset });
    // a point (offset, t) of the plane x = offset at height z rotates by rate z
    const onSurface = (offset: number, t: number, z: number): Vec3 => {
      const [cos, sin] = [Math.cos(rate * z), Math.sin(rate * z)];
      return [offset * cos - t * sin, offset * sin + t * cos, z];
    };
    for (const [offset, t, z] of [
      [0, 3, 0],
      [0, -4, 17],
      [2, 1, 30],
      [-2, 5, -12],
    ] as const)
      expect(surface(offset)(onSurface(offset, t, z))).toBeCloseTo(0, 12);
    // moved 0.4 across the surface at height 0 (the plane x = 0): first order, |g| / |grad g| with grad g = (1, 0, k t) at t = 3
    expect(surface(0)([0.4, 3, 0])).toBeCloseTo(0.4 / Math.hypot(1, rate * 3), 12);
  });

  it('names the first missing field', () => {
    expect(referenceDistance({ kind: 'sphere', center: [0, 0, 0] })).toEqual({ missing: 'radius' });
    expect(referenceDistance({ kind: 'plane', point: [0, 0, 0], normal: [0, 0, 0] })).toEqual({ missing: 'normal' });
    expect(referenceDistance({ kind: 'ellipticCylinder', point: [0, 0, 0], axis: [0, 0, 1], reference: [0, 0, 1], radii: [1, 1] })).toEqual(
      { missing: 'reference' },
    );
    expect(referenceDistance({ kind: 'ellipticCylinder', point: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0], radii: [1] })).toEqual({
      missing: 'radii',
    });
    expect(referenceDistance({ kind: 'helicoid', point: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] })).toEqual({ missing: 'rate' });
    expect(maxDeviation(distanceOf({ kind: 'plane', point: [0, 0, 0], normal: [0, 1, 0] }), [0, 2, 0, 0, -3, 0]).max).toBe(3);
  });
});

describe.each(KERNELS)('analyze_deformation compareTo the shape a law produces, kernel: %s', (kind) => {
  const compare = (doc: Parameters<typeof execute>[0], id: string, compareTo: object): number => {
    const result = execute(doc, 'analyze_deformation', { id, compareTo });
    expect(result.error, result.summary).toBeUndefined();
    return dataOf<{ compareTo: { maxDeviation: number } }>(result).compareTo.maxDeviation;
  };

  it('a sphere scaled by 2 is the sphere of twice the radius; a wrong radius is measured as the difference', async () => {
    await installKernel(kind);
    const sphere = execute(createEmptyDocument(), 'add_sphere', { radius: 10 });
    const id = sphere.affected[0] as string;
    const scaled = execute(sphere.document, 'scale_nonuniform', { id, factors: [2, 2, 2], output: { tolerance: 0.01 } });
    expect(scaled.error, scaled.summary).toBeUndefined();
    const next = scaled.affected[0] as string;
    const center = [0, 0, 0];
    expect(compare(scaled.document, next, { kind: 'sphere', center, radius: 20 })).toBeLessThan(1e-3);
    expect(compare(scaled.document, next, { kind: 'sphere', center, radius: 19.5 })).toBeCloseTo(0.5, 1);
    expectPure(scaled.document, () =>
      execute(scaled.document, 'analyze_deformation', { id: next, compareTo: { kind: 'sphere', center, radius: 20 } }),
    );
  });

  it('a thin plate stretched along its length stays in its plane; a plane shifted by 0.3 is 0.3 away', async () => {
    await installKernel(kind);
    const { doc, id } = addBox([10, 0.002, 100]);
    const stretched = execute(doc, 'stretch_body', { id, factor: 1.5, frame: WORLD_Z, output: { tolerance: 0.01 } });
    const next = stretched.affected[0] as string;
    expect(compare(stretched.document, next, { kind: 'plane', point: [0, 0, 0], normal: [0, 1, 0] })).toBeLessThan(0.0011);
    expect(compare(stretched.document, next, { kind: 'plane', point: [0, 0.3, 0], normal: [0, 1, 0] })).toBeCloseTo(0.3, 2);
  });

  it('a thin plate twisted at a constant rate is a helicoid; the wrong rate and the wrong offset are measured', async () => {
    await installKernel(kind);
    const { doc, id } = addBox([10, 0.002, 100], 'base-center');
    // 36 degrees per 20 units on the whole axis: 0.0314159 rad per unit
    const twisted = execute(doc, 'twist_body', {
      id,
      angleDeg: 36,
      frame: WORLD_Z,
      region: { start: 0, end: 20, infinite: true },
      output: { tolerance: 0.005 },
    });
    expect(twisted.error, twisted.summary).toBeUndefined();
    const next = twisted.affected[0] as string;
    const rate = (36 * Math.PI) / 180 / 20;
    const helicoid = { kind: 'helicoid', point: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0], rate };
    // the plate is the plane y = 0 (normal along +y), the helicoid generated by the plane through the axis with normal +x is at 90 degrees: offset 0 and rotated reference
    const aligned = { ...helicoid, reference: [0, 1, 0] };
    expect(compare(twisted.document, next, aligned)).toBeLessThan(0.0015);
    expect(compare(twisted.document, next, { ...aligned, offset: 0.2 })).toBeCloseTo(0.2, 1);
    expect(compare(twisted.document, next, { ...aligned, rate: rate * 1.1 })).toBeGreaterThan(0.5);
  });

  it('a cylinder scaled [2, 1, 1] is the elliptic cylinder 10 x 5 (the Manifold mesh has no cap centre vertex); a wrong semi-axis is the difference', async () => {
    await installKernel('manifold');
    const { doc, id } = addCylinder(5, 40);
    const scaled = execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 1], output: { tolerance: 0.01 } });
    expect(scaled.error, scaled.summary).toBeUndefined();
    const next = scaled.affected[0] as string;
    const ellipse = { kind: 'ellipticCylinder', point: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] };
    expect(compare(scaled.document, next, { ...ellipse, radii: [10, 5] })).toBeLessThan(0.02);
    expect(compare(scaled.document, next, { ...ellipse, radii: [10.3, 5] })).toBeCloseTo(0.3, 1);
  });

  it('refuses an incomplete reference of the new kinds by name', async () => {
    await installKernel(kind);
    const { doc, id } = addBox([10, 0.002, 100]);
    const stretched = execute(doc, 'stretch_body', { id, factor: 1.5, frame: WORLD_Z });
    const next = stretched.affected[0] as string;
    const wrong = execute(stretched.document, 'analyze_deformation', {
      id: next,
      compareTo: { kind: 'helicoid', point: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] },
    });
    expectNoOp(wrong, stretched.document, 'compareTo.rate');
    expect(wrong.error?.code).toBe('DEF_COMPARE_INVALID');
  });
});
