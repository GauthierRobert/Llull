/** Exact rational NURBS test surfaces (sphere, cylinder, torus) as surfaces of revolution about the z axis (Piegl & Tiller A8.1). */

import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import type { Vec3 } from '@core/model/types';

const SQRT_HALF = Math.SQRT1_2;

/** Unit circle as nine poles / weights (rational quadratic, four spans); u runs counter-clockwise from +x. */
const CIRCLE: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1],
  [1, 1, SQRT_HALF],
  [0, 1, 1],
  [-1, 1, SQRT_HALF],
  [-1, 0, 1],
  [-1, -1, SQRT_HALF],
  [0, -1, 1],
  [1, -1, SQRT_HALF],
  [1, 0, 1],
];

interface ProfilePole {
  /** Distance from the axis. */
  readonly radius: number;
  readonly z: number;
  readonly weight: number;
}

/**
 * The patch swept by turning `profile` (a rational NURBS curve in the (radius, z) half-plane given by its poles and the curve's knots)
 * a full turn about z: u = the turn, v = the profile parameter.
 */
function revolveProfile(
  profile: ReadonlyArray<ProfilePole>,
  degreeV: number,
  knotsV: ReadonlyArray<number>,
  multiplicitiesV: ReadonlyArray<number>,
): NurbsSurfaceData {
  const poles: Vec3[][] = CIRCLE.map(([cx, cy]) => profile.map((pole): Vec3 => [pole.radius * cx, pole.radius * cy, pole.z]));
  const weights = CIRCLE.map(([, , w]) => profile.map((pole) => pole.weight * w));
  return {
    degreeU: 2,
    degreeV,
    poles,
    weights,
    knotsU: [0, 0.25, 0.5, 0.75, 1],
    multiplicitiesU: [3, 2, 2, 2, 3],
    knotsV: [...knotsV],
    multiplicitiesV: [...multiplicitiesV],
  };
}

/** Sphere of radius `radius` centred at the origin: v from the south pole (-z) to the north pole. */
export function sphereSurface(radius: number): NurbsSurfaceData {
  const semicircle: ProfilePole[] = [
    { radius: 0, z: -radius, weight: 1 },
    { radius, z: -radius, weight: SQRT_HALF },
    { radius, z: 0, weight: 1 },
    { radius, z: radius, weight: SQRT_HALF },
    { radius: 0, z: radius, weight: 1 },
  ];
  return revolveProfile(semicircle, 2, [0, 0.5, 1], [3, 2, 3]);
}

/** Cylinder of radius `radius` around the z axis between z = 0 and `height`. */
export function cylinderSurface(radius: number, height: number): NurbsSurfaceData {
  return revolveProfile(
    [
      { radius, z: 0, weight: 1 },
      { radius, z: height, weight: 1 },
    ],
    1,
    [0, 1],
    [2, 2],
  );
}

/** Torus with centre-circle radius `ringRadius` and tube radius `tubeRadius` around the z axis; v turns the tube from the outer equator. */
export function torusSurface(ringRadius: number, tubeRadius: number): NurbsSurfaceData {
  const [R, r] = [ringRadius, tubeRadius];
  const tube: ProfilePole[] = CIRCLE.map(([cx, cz, weight]) => ({ radius: R + r * cx, z: r * cz, weight }));
  return revolveProfile(tube, 2, [0, 0.25, 0.5, 0.75, 1], [3, 2, 2, 2, 3]);
}
