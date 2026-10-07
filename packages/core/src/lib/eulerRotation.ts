/**
 * Euler rotation matching three.js intrinsic 'XYZ' (`<mesh rotation={[rx, ry, rz]}/>`):
 * M = Rx · Ry · Rz, so Rz is applied to the vector FIRST, then Ry, then Rx.
 *
 * @layer lib
 * @pure
 */

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

type Matrix3 = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

function multiply3(a: Matrix3, b: Matrix3): Matrix3 {
  const cell = (row: 0 | 1 | 2, col: 0 | 1 | 2): number =>
    a[row][0] * b[0][col] + a[row][1] * b[1][col] + a[row][2] * b[2][col];
  return [
    [cell(0, 0), cell(0, 1), cell(0, 2)],
    [cell(1, 0), cell(1, 1), cell(1, 2)],
    [cell(2, 0), cell(2, 1), cell(2, 2)],
  ];
}

function eulerToMatrix([rx, ry, rz]: Vec3): Matrix3 {
  const [cx, sx, cy, sy, cz, sz] = [
    Math.cos(rx),
    Math.sin(rx),
    Math.cos(ry),
    Math.sin(ry),
    Math.cos(rz),
    Math.sin(rz),
  ];
  const rotationX: Matrix3 = [
    [1, 0, 0],
    [0, cx, -sx],
    [0, sx, cx],
  ];
  const rotationY: Matrix3 = [
    [cy, 0, sy],
    [0, 1, 0],
    [-sy, 0, cy],
  ];
  const rotationZ: Matrix3 = [
    [cz, -sz, 0],
    [sz, cz, 0],
    [0, 0, 1],
  ];
  return multiply3(multiply3(rotationX, rotationY), rotationZ);
}

/** three.js `Euler.setFromRotationMatrix(m, 'XYZ')`. */
function matrixToEuler(m: Matrix3): [number, number, number] {
  const y = Math.asin(Math.max(-1, Math.min(1, m[0][2])));
  if (Math.abs(m[0][2]) < 0.9999999) {
    return [Math.atan2(-m[1][2], m[2][2]), y, Math.atan2(-m[0][1], m[0][0])];
  }
  return [Math.atan2(m[2][1], m[1][1]), y, 0];
}

/** Rotation of `inner` followed by a WORLD-frame rotation `outer`, as intrinsic XYZ Euler angles. */
export function composeEulerXYZ(outer: Vec3, inner: Vec3): [number, number, number] {
  if (isZeroRotation(inner)) return [outer[0], outer[1], outer[2]];
  if (isZeroRotation(outer)) return [inner[0], inner[1], inner[2]];
  return matrixToEuler(multiply3(eulerToMatrix(outer), eulerToMatrix(inner)));
}

/** `euler` after an extra rotation of `angle` radians about the WORLD Z axis. */
export function rotateEulerAboutWorldZ(euler: Vec3, angle: number): [number, number, number] {
  return composeEulerXYZ([0, 0, angle], euler);
}
