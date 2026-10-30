/** Rational / polynomial B-spline patches in the shape `faceQuery.bspline` answers, with a closed form to check a freeform chart against (03 WRP, spec §14.10). */

import type { FaceQueryPort } from '@core/geometry/kernelPorts';
import type { Vec3 } from '@core/model/types';

export type PortSurface = NonNullable<ReturnType<FaceQueryPort['bspline']>>;

/** Rational quadratic arc of radius `r` from angle a0 to a1 (< pi): poles (x, y) in the arc's plane and weights. */
function arc(r: number, a0: number, a1: number): { poles: [number, number][]; weights: number[] } {
  const half = (a1 - a0) / 2;
  const mid = (a0 + a1) / 2;
  return {
    poles: [
      [r * Math.cos(a0), r * Math.sin(a0)],
      [(r * Math.cos(mid)) / Math.cos(half), (r * Math.sin(mid)) / Math.cos(half)],
      [r * Math.cos(a1), r * Math.sin(a1)],
    ],
    weights: [1, Math.cos(half), 1],
  };
}

const unit = (
  degreeU: number,
  degreeV: number,
): Pick<PortSurface, 'knotsU' | 'multsU' | 'knotsV' | 'multsV' | 'periodicU' | 'periodicV'> => ({
  knotsU: [0, 1],
  multsU: [degreeU + 1, degreeU + 1],
  knotsV: [0, 1],
  multsV: [degreeV + 1, degreeV + 1],
  periodicU: false,
  periodicV: false,
});

/** Cylinder of radius r about z: u = azimuth from a0 to a1 (rational arc), v = height 0..height (linear). Su x Sv points outward. */
export function cylinderPatch(r: number, a0: number, a1: number, height: number): PortSurface {
  const { poles, weights } = arc(r, a0, a1);
  return {
    degreeU: 2,
    degreeV: 1,
    poles: poles.map(([x, y]) => [[x, y, 0] as Vec3, [x, y, height] as Vec3]),
    weights: weights.map((w) => [w, w]),
    ...unit(2, 1),
  };
}

/** Sphere of radius r about the origin: u = azimuth a0..a1, v = latitude l0..l1 (both rational arcs), tensor product of the two. */
export function spherePatch(r: number, a0: number, a1: number, l0: number, l1: number): PortSurface {
  const azimuth = arc(1, a0, a1);
  const latitude = arc(r, l0, l1);
  return {
    degreeU: 2,
    degreeV: 2,
    poles: azimuth.poles.map(([cx, cy]) => latitude.poles.map(([ring, z]) => [ring * cx, ring * cy, z] as Vec3)),
    weights: azimuth.weights.map((wu) => latitude.weights.map((wv) => wu * wv)),
    ...unit(2, 2),
  };
}

/** Bezier patch z = k (x^2 - y^2) over [-half, half]^2 (a saddle, Gaussian curvature -4 k^2 at the origin), u along x, v along y. */
export function saddlePatch(k: number, half: number): PortSurface {
  const coefficient = [1, -1, 1];
  return {
    degreeU: 2,
    degreeV: 2,
    poles: [0, 1, 2].map((i) =>
      [0, 1, 2].map(
        (j) => [half * (i - 1), half * (j - 1), k * half * half * ((coefficient[i] as number) - (coefficient[j] as number))] as Vec3,
      ),
    ),
    ...unit(2, 2),
  };
}
