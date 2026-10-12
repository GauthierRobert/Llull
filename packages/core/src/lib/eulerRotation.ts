/**
 * Euler rotation matching three.js intrinsic 'XYZ' (`<mesh rotation={[rx, ry, rz]}/>`):
 * M = Rx · Ry · Rz, so Rz is applied to the vector FIRST, then Ry, then Rx.
 *
 * @layer lib
 * @pure
 */

import { eulerFromMat, mulMat3, type Mat3 } from './axisRotation';

type Vec3 = readonly [number, number, number];

/** Rotate `v` by `euler` about `origin`. */
export function applyEulerXYZ(v: Vec3, origin: Vec3, euler: Vec3): [number, number, number] {
  const [rx, ry, rz] = euler;
  const x0 = v[0] - origin[0];
  const y0 = v[1] - origin[1];
  const z0 = v[2] - origin[2];

  const x1 = Math.cos(rz) * x0 - Math.sin(rz) * y0;
  const y1 = Math.sin(rz) * x0 + Math.cos(rz) * y0;

  const x2 = Math.cos(ry) * x1 + Math.sin(ry) * z0;
  const z2 = -Math.sin(ry) * x1 + Math.cos(ry) * z0;

  const y3 = Math.cos(rx) * y1 - Math.sin(rx) * z2;
  const z3 = Math.sin(rx) * y1 + Math.cos(rx) * z2;

  return [x2 + origin[0], y3 + origin[1], z3 + origin[2]];
}

export function isZeroRotation(euler: Vec3): boolean {
  return euler[0] === 0 && euler[1] === 0 && euler[2] === 0;
}

/** Rx · Ry · Rz as an explicit product (its signed zeros pick the ±π branch of `matrixToEuler`). */
function eulerToMatrix([rx, ry, rz]: Vec3): Mat3 {
  const [cx, sx, cy, sy, cz, sz] = [rx, ry, rz].flatMap((a) => [Math.cos(a), Math.sin(a)]) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const rotationX: Mat3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const rotationY: Mat3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rotationZ: Mat3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mulMat3(mulMat3(rotationX, rotationY), rotationZ);
}

/** three.js `Euler.setFromRotationMatrix(m, 'XYZ')`, with -0 normalized to 0. */
function matrixToEuler(m: Mat3): [number, number, number] {
  const [x, y, z] = eulerFromMat(m);
  return [x + 0, y + 0, z + 0];
}

/** Rotation of `inner` followed by a WORLD-frame rotation `outer`, as intrinsic XYZ Euler angles. */
export function composeEulerXYZ(outer: Vec3, inner: Vec3): [number, number, number] {
  if (isZeroRotation(inner)) return [outer[0], outer[1], outer[2]];
  if (isZeroRotation(outer)) return [inner[0], inner[1], inner[2]];
  return matrixToEuler(mulMat3(eulerToMatrix(outer), eulerToMatrix(inner)));
}

/** `euler` after an extra rotation of `angle` radians about the WORLD Z axis. */
export function rotateEulerAboutWorldZ(euler: Vec3, angle: number): [number, number, number] {
  return composeEulerXYZ([0, 0, angle], euler);
}

/** Intrinsic XYZ Euler angles of the rotation taking world X/Y/Z onto the orthonormal `x`/`y`/`z`. */
export function eulerFromAxes(x: Vec3, y: Vec3, z: Vec3): [number, number, number] {
  return matrixToEuler([x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]]);
}

/** `v` rotated by the inverse of `euler` ((Rx·Ry·Rz)⁻¹ = Rz⁻¹·Ry⁻¹·Rx⁻¹), about the origin. */
export function inverseEulerXYZ(v: Vec3, [rx, ry, rz]: Vec3): [number, number, number] {
  const o: Vec3 = [0, 0, 0];
  return applyEulerXYZ(applyEulerXYZ(applyEulerXYZ(v, o, [-rx, 0, 0]), o, [0, -ry, 0]), o, [
    0,
    0,
    -rz,
  ]);
}
