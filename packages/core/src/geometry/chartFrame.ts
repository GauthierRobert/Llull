/**
 * Shared types and frame helpers of the face charts of 03 WRP (`wrapChart` for developable faces, `curvedChart` for sphere and torus): a chart carries a sketch
 * onto a face's (u, v) and back to 3D.
 */

import type { EmbossSurface } from '../model/wrap';
import type { Vec2, Vec3 } from '../model/vectors';
import { cross3, dot3, normalize3, scale3, sub3 } from '../lib/vec3';

export interface ChartPlacement {
  /** Sketch point that lands on `anchorOn`. */
  readonly anchorChart: Vec2;
  /** A point on the face. */
  readonly anchorOn: Vec3;
  readonly angleDeg: number;
  readonly mirror: boolean;
}

type ChartKind = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'freeform';

/** How a chart is built: develop (isometry, K = 0 faces), geodesic (exponential map about the anchor), parametric (arc-length scaled (u, v)). */
export type ChartMethod = 'develop' | 'geodesic' | 'parametric';

export interface FaceChart {
  readonly kind: ChartKind;
  readonly method: ChartMethod;
  /** Wire form of the surface (`faceSlab` layout) whose (u, v) the chart produces. */
  readonly wire: EmbossSurface;
  readonly affine: boolean;
  readonly anchorUv: Vec2;
  /** The sketch point that lands on the anchor. */
  readonly anchorChart: Vec2;
  /** Length of a full turn in the chart x direction at the anchor; null on a plane. */
  readonly fullWrapWidth: number | null;
  /** (u, v) of a chart point; null where the chart is not defined (a cone apex, beyond the extent a geodesic chart reaches). */
  readonly uvAt: (point: Vec2) => Vec2 | null;
  /** What a null `uvAt` means, for the refusal text. */
  readonly nullMeaning: string;
  /** 3D point of (u, v). */
  readonly pointAt: (uv: Vec2) => Vec3;
  /** Unit normal in the direction of Su x Sv at (u, v): the sign reference of a lift (the kernel lifts along it, or against it when the wanted direction opposes it). */
  readonly normalAt: (uv: Vec2) => Vec3;
  /** (u, v) of a 3D point on the surface; the azimuth is wrapped to (-pi, pi]. */
  readonly uvOfPoint: (point: Vec3) => Vec2;
  /** Bound of the 3D length per unit of (u, v) change within `reach` (chart units) of the anchor: fit tolerances in (u, v) divide by it. */
  readonly metricBound: (reach: number) => number;
  /** Antiderivative in v of the area element |Su x Sv| (a freeform face: from the lower parameter bound, at the given u): a (u, v) region has the area of minus the counter-clockwise loop integral of areaG(v) du. */
  readonly areaG: (v: number, u: number) => number;
  /** Why a chart point has no (u, v), when the chart can tell (a freeform geodesic chart: a fold of the exponential map or the edge of the surface); null where it is defined. */
  readonly diagnose?: (point: Vec2) => 'fold' | 'outside' | null;
}

export type ChartResult = FaceChart | { readonly error: string };

/** `axis` completed to a right-handed frame (x orthogonalised against it). */
export function frameOf(axis: Vec3, xDir: Vec3): { axis: Vec3; x: Vec3; y: Vec3 } {
  const a = normalize3(axis);
  const x = normalize3(sub3(xDir, scale3(a, dot3(xDir, a))));
  return { axis: a, x, y: cross3(a, x) };
}

/** Chart displacement of sketch point `p` from the anchor: mirror y, turn by the angle. */
export function displacement(placement: ChartPlacement, p: Vec2): Vec2 {
  const qx = p[0] - placement.anchorChart[0];
  const qy = (placement.mirror ? -1 : 1) * (p[1] - placement.anchorChart[1]);
  const angle = (placement.angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [cos * qx - sin * qy, sin * qx + cos * qy];
}
