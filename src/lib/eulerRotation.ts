/**
 * Pure Euler-rotation helpers shared by the render and scene layers.
 *
 * Convention: three.js intrinsic 'XYZ' order, column-vector composition.
 * M = Rx · Ry · Rz, meaning Rz is applied to the vector FIRST, then Ry, then Rx.
 * This matches `<mesh rotation={[rx, ry, rz]}/>` in the r3f viewport.
 *
 * @layer lib
 * @pure
 */

/** Minimal 3-component vector type (plain tuple). */
type Vec3 = readonly [number, number, number];

/**
 * Apply a three.js-style intrinsic XYZ Euler rotation (M = Rx · Ry · Rz) to a
 * world-space vertex, rotating about `origin`.
 *
 * Column-vector composition: Rz acts first, then Ry, then Rx.
 * Verified against three.js Matrix4.makeRotationFromEuler (XYZ order) where
 * M[0][2] = sin(y) — consistent with Rx·Ry·Rz applied to (0,0,1).
 *
 * @pure
 */
export function applyEulerXYZ(v: Vec3, origin: Vec3, euler: Vec3): [number, number, number] {
  const [rx, ry, rz] = euler;
  // Translate to origin-relative space
  let x = v[0] - origin[0];
  let y = v[1] - origin[1];
  let z = v[2] - origin[2];

  // Rz first
  const czr = Math.cos(rz), szr = Math.sin(rz);
  const x1 = czr * x - szr * y;
  const y1 = szr * x + czr * y;
  x = x1; y = y1;

  // Ry second
  const cyr = Math.cos(ry), syr = Math.sin(ry);
  const x2 = cyr * x + syr * z;
  const z2 = -syr * x + cyr * z;
  x = x2; z = z2;

  // Rx last
  const cxr = Math.cos(rx), sxr = Math.sin(rx);
  const y3 = cxr * y - sxr * z;
  const z3 = sxr * y + cxr * z;
  y = y3; z = z3;

  return [x + origin[0], y + origin[1], z + origin[2]];
}

/** True when the rotation is the identity — lets callers skip the rotation pass cheaply. */
export function isZeroRotation(euler: Vec3): boolean {
  return euler[0] === 0 && euler[1] === 0 && euler[2] === 0;
}
