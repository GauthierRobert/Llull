/** Pure element-shape metrics of the Verdict library (Sandia SAND2007-2853, 05 §5.5, TR-FEA-31) on corner nodes: tetrahedron, triangle, quadrilateral. */

import type { Vec3 } from '@core/model/vectors';
import { cross3, dot3, len3, sub3 } from '@lib/vec3';

export interface TetMetrics {
  /** Verdict scaled Jacobian `J sqrt(2) / lambdaMax` (1 regular, <= 0 inverted). */
  readonly scaledJacobian: number;
  /** Verdict aspect ratio `Lmax / (2 sqrt(6) r_in)` (1 regular); computed on |V|, so an inverted regular tet still reads 1. */
  readonly aspectRatio: number;
  /** Longest / shortest edge. */
  readonly edgeRatio: number;
  readonly volume: number;
}

export interface TriMetrics {
  /** Smallest interior angle in degrees (60 equilateral). */
  readonly minAngleDeg: number;
  readonly area: number;
}

export interface QuadMetrics {
  /** Verdict aspect ratio `Lmax (L0 + L1 + L2 + L3) / (4 A)`, A = |d1 x d2| / 2 (1 square). */
  readonly aspectRatio: number;
  /** Verdict scaled Jacobian: the smallest signed corner Jacobian over the product of its edge lengths (1 square, <= 0 inverted). */
  readonly scaledJacobian: number;
  /** `|X1 . X2| / (|X1| |X2|)` over the principal axes (0 rectangle). */
  readonly skew: number;
  /** `1 - min(n0 . n2, n1 . n3)^3` over the corner normals (0 flat). Informational only (open question 10). */
  readonly warpage: number;
}

/** Tetrahedron metrics of corners p0..p3 (positive volume = Verdict / CalculiX node order). */
export function tetMetrics(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3): TetMetrics {
  const l0 = sub3(p1, p0);
  const l1 = sub3(p2, p1);
  const l2 = sub3(p0, p2);
  const l3 = sub3(p3, p0);
  const l4 = sub3(p3, p1);
  const l5 = sub3(p3, p2);
  const jacobian = dot3(cross3(l2, l0), l3);
  const [n0, n1, n2, n3, n4, n5] = [l0, l1, l2, l3, l4, l5].map(len3) as [number, number, number, number, number, number];
  const lambdaMax = Math.max(n0 * n2 * n3, n0 * n1 * n4, n1 * n2 * n5, n3 * n4 * n5, jacobian);
  const volume = Math.abs(jacobian) / 6;
  const area = [
    [p0, p1, p2],
    [p0, p1, p3],
    [p1, p2, p3],
    [p0, p2, p3],
  ].reduce((sum, [a, b, c]) => sum + len3(cross3(sub3(b ?? p0, a ?? p0), sub3(c ?? p0, a ?? p0))) / 2, 0);
  const inradius = area > 0 ? (3 * volume) / area : 0;
  const longest = Math.max(n0, n1, n2, n3, n4, n5);
  const shortest = Math.min(n0, n1, n2, n3, n4, n5);
  return {
    scaledJacobian: lambdaMax > 0 ? (Math.SQRT2 * jacobian) / lambdaMax : 0,
    aspectRatio: inradius > 0 ? longest / (2 * Math.sqrt(6) * inradius) : Number.MAX_SAFE_INTEGER,
    edgeRatio: shortest > 0 ? longest / shortest : Number.MAX_SAFE_INTEGER,
    volume,
  };
}

/** Triangle metrics of corners p0..p2. */
export function triMetrics(p0: Vec3, p1: Vec3, p2: Vec3): TriMetrics {
  const angle = (apex: Vec3, a: Vec3, b: Vec3): number => {
    const u = sub3(a, apex);
    const v = sub3(b, apex);
    const scale = len3(u) * len3(v);
    return scale > 0 ? (Math.acos(Math.min(1, Math.max(-1, dot3(u, v) / scale))) * 180) / Math.PI : 0;
  };
  return {
    minAngleDeg: Math.min(angle(p0, p1, p2), angle(p1, p2, p0), angle(p2, p0, p1)),
    area: len3(cross3(sub3(p1, p0), sub3(p2, p0))) / 2,
  };
}

const unit = (v: Vec3): Vec3 => {
  const length = len3(v);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 0];
};

/** Quadrilateral metrics of corners p0..p3 (counter-clockwise about the intended normal). */
export function quadMetrics(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3): QuadMetrics {
  const corners = [p0, p1, p2, p3];
  const edges = corners.map((point, index) => sub3(corners[(index + 1) % 4] ?? point, point));
  const lengths = edges.map(len3);
  const center = cross3(sub3(p2, p0), sub3(p3, p1));
  const area = len3(center) / 2;
  const normal = unit(center);
  const corner = (index: number): Vec3 => cross3(edges[index] ?? [0, 0, 0], sub3(corners[(index + 3) % 4] ?? p0, corners[index] ?? p0));
  const jacobians = [0, 1, 2, 3].map((index) => {
    const incoming = lengths[(index + 3) % 4] ?? 0;
    const scale = (lengths[index] ?? 0) * incoming;
    return scale > 0 ? dot3(normal, corner(index)) / scale : 0;
  });
  const x1 = sub3([p1[0] + p2[0], p1[1] + p2[1], p1[2] + p2[2]], [p0[0] + p3[0], p0[1] + p3[1], p0[2] + p3[2]]);
  const x2 = sub3([p2[0] + p3[0], p2[1] + p3[1], p2[2] + p3[2]], [p0[0] + p1[0], p0[1] + p1[1], p0[2] + p1[2]]);
  const axes = len3(x1) * len3(x2);
  const normals = [0, 1, 2, 3].map((index) => unit(corner(index)));
  const warp = Math.min(dot3(normals[0] ?? normal, normals[2] ?? normal), dot3(normals[1] ?? normal, normals[3] ?? normal));
  return {
    aspectRatio: area > 0 ? (Math.max(...lengths) * lengths.reduce((sum, value) => sum + value, 0)) / (4 * area) : Number.MAX_SAFE_INTEGER,
    scaledJacobian: Math.min(...jacobians),
    skew: axes > 0 ? Math.abs(dot3(x1, x2)) / axes : 1,
    warpage: 1 - warp ** 3,
  };
}
