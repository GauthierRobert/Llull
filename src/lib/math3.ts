/**
 * Pure 3-D math helpers shared across core layers.
 * No external dependencies; no DOM / React / three.js.
 *
 * @layer lib
 */

/**
 * 3-component vector. Defined locally (not imported from `core`) to preserve the
 * one-way dependency law `ui → core → lib`: `lib` must not reach up into `core`.
 * Structurally identical to `core/model/types` `Vec3`, so values flow both ways.
 */
export type Vec3 = readonly [number, number, number];

/**
 * Apply a three.js-style intrinsic XYZ Euler rotation (M = Rx · Ry · Rz) to a
 * world-space point, rotating about `origin`.
 *
 * Column-vector composition: Rz acts on the vector first, then Ry, then Rx.
 * Matches three.js `<mesh rotation={[rx,ry,rz]}/>` (Euler order 'XYZ') and the
 * live viewport convention.
 *
 * @pure
 */
export function applyEulerXYZ(v: Vec3, origin: Vec3, euler: Vec3): Vec3 {
  const [rx, ry, rz] = euler;

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
