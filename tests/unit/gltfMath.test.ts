/** import_gltf matrix helpers: composition, T/R/S construction and T / Euler XYZ / S decomposition (VIS-M8d). */
import { describe, it, expect } from 'vitest';
import { IDENTITY, decompose, determinant3, fromTrs, multiply, transformPoint } from '@core/commands/exchange/gltfMath';
import { exactShapeKeyOf } from '@core/commands/exchange/gltfPrototypes';
import { applyEulerXYZ } from '@lib/eulerRotation';
import { DEFAULT_LAYER_ID, type Entity, type Vec3 } from '@core/model/types';

const quaternionAbout = (axis: 0 | 1 | 2, angle: number): number[] => {
  const q = [0, 0, 0, Math.cos(angle / 2)];
  q[axis] = Math.sin(angle / 2);
  return q;
};
const round = (v: readonly number[]): number[] => v.map((c) => Math.round(c * 1e9) / 1e9 + 0);

describe('gltfMath', () => {
  it('fromTrs: a zero quaternion is the identity rotation, short vectors default to identity / 1', () => {
    expect(round(fromTrs([1, 2, 3], [0, 0, 0, 0], [2, 3, 4]))).toEqual([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 1, 2, 3, 1]);
    expect(fromTrs([], [], [])).toEqual(IDENTITY);
  });

  it('multiply applies the right matrix first; transformPoint reads missing elements as 0', () => {
    const move = fromTrs([10, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    const spin = fromTrs([0, 0, 0], quaternionAbout(2, Math.PI / 2), [1, 1, 1]);
    expect(round(transformPoint(multiply(move, spin), 1, 0, 0))).toEqual([10, 1, 0]);
    expect(transformPoint([], 1, 2, 3)).toEqual([0, 0, 0]);
    expect(multiply([], [])).toEqual(new Array(16).fill(0));
    expect(determinant3([])).toBe(0);
  });

  it.each<Vec3>([
    [0.3, -0.7, 1.9],
    [0, Math.PI / 2, 0],
    [0.4, -Math.PI / 2, 0],
    [-1.1, Math.PI / 2, 0],
  ])('decompose recovers an Euler XYZ rotation that rotates like applyEulerXYZ (%j, gimbal lock at +-90 degrees included)', (...angles) => {
    const euler = angles as Vec3;
    const q = quaternionOfEuler(euler);
    const result = decompose(fromTrs([1, 2, 3], q, [2, 3, 4]));
    if (typeof result === 'string') throw new Error(result);
    expect(round(result.position)).toEqual([1, 2, 3]);
    expect(round(result.scale)).toEqual([2, 3, 4]);
    const point: Vec3 = [0.5, -1.5, 2];
    round(applyEulerXYZ(point, [0, 0, 0], result.rotation)).forEach((c, k) =>
      expect(c).toBeCloseTo(round(applyEulerXYZ(point, [0, 0, 0], euler))[k] as number, 6),
    );
  });

  it('decompose names what is not a T R S: zero column, mirror, shear', () => {
    expect(decompose(fromTrs([0, 0, 0], [0, 0, 0, 1], [1, 0, 1]))).toBe('degenerate');
    expect(decompose(fromTrs([0, 0, 0], [0, 0, 0, 1], [-1, 1, 1]))).toBe('mirrored');
    const sheared = multiply(fromTrs([0, 0, 0], [0, 0, 0, 1], [1, 3, 1]), fromTrs([0, 0, 0], quaternionAbout(2, Math.PI / 4), [1, 1, 1]));
    expect(decompose(sheared)).toBe('sheared');
    expect(decompose([])).toBe('degenerate');
  });

  it('exactShapeKeyOf keeps NaN, Infinity and -0 apart from null and 0', () => {
    const box = (size: Vec3): Entity => ({
      id: 'b',
      kind: 'box',
      size,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color: '#808080',
    });
    const sizes: Vec3[] = [
      [1, 2, 3],
      [1, 2, -0],
      [1, 2, NaN],
      [1, 2, Infinity],
      [1, 2, -Infinity],
    ];
    const keys = sizes.map((size) => exactShapeKeyOf(box(size)));
    expect(new Set(keys).size).toBe(5);
    expect(exactShapeKeyOf(box([1, 2, 3]))).toBe(
      exactShapeKeyOf({ ...box([1, 2, 3]), id: 'other', position: [9, 9, 9], color: '#ff0000' }),
    );
  });
});

/** Quaternion [x, y, z, w] of the intrinsic Euler XYZ rotation (q = qx · qy · qz). */
function quaternionOfEuler([rx, ry, rz]: Vec3): number[] {
  const qx = quaternionAbout(0, rx);
  const qy = quaternionAbout(1, ry);
  const qz = quaternionAbout(2, rz);
  const mul = (a: number[], b: number[]): number[] => {
    const [ax = 0, ay = 0, az = 0, aw = 1] = a;
    const [bx = 0, by = 0, bz = 0, bw = 1] = b;
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  };
  return mul(mul(qx, qy), qz);
}
