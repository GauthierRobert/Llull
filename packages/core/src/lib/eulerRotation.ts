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
