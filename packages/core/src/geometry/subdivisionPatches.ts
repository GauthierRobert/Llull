/**
 * Exact-surface form of a subdivision solid: one bicubic Bézier patch per quad of the once-refined cage (Loop & Schaefer geometry patches).
 * Around regular vertices (four smooth edges) the patch IS the Catmull-Clark limit surface (uniform bicubic B-spline converted to Bézier
 * form); near extraordinary vertices and next to creases it approximates it closely. Neighbouring patches share their boundary control
 * points exactly, so the patches sew into a closed solid. Crease edges follow the crease's cubic B-spline curve; crease corners stay put.
 * Pure; the OCC kernel builds B-spline faces from these poles.
 */

import type { Vec3 } from '../model/types';
import { add3, scale3 } from '../lib/vec3';
import { type Cage, subdivide } from './subdivision';
import { edgeKey } from './subd/edgeKey';
import { settleLevels } from './subd/settle';
import { SHARP_MAX } from './subd/sharpness';

/** Sixteen control points of a bicubic Bézier patch, `poles[i * 4 + j]` = P(i, j). */
export type BezierPatch = readonly Vec3[];

const sum = (points: readonly Vec3[]): Vec3 => points.reduce<Vec3>((total, p) => add3(total, p), [0, 0, 0]);

/** Patches of a quad-only cage (every face 4 vertices, closed, consistently wound). */
export function quadCagePatches(cage: Cage): BezierPatch[] {
  const { vertices, faces } = cage;
  const at = (v: number): Vec3 => vertices[v] as Vec3;
  const sharp = new Set(cage.creases.map(([a, b]) => edgeKey(a, b)));
  const valence = vertices.map(() => 0);
  const creaseNeighbours = vertices.map((): number[] => []);
  const seen = new Set<string>();
  for (const face of faces)
    face.forEach((a, i) => {
      const b = face[(i + 1) % 4] as number;
      if (seen.has(edgeKey(a, b))) return;
      seen.add(edgeKey(a, b));
      valence[a] = (valence[a] as number) + 1;
      valence[b] = (valence[b] as number) + 1;
      if (sharp.has(edgeKey(a, b))) {
        creaseNeighbours[a]?.push(b);
        creaseNeighbours[b]?.push(a);
      }
    });
  /** Interior point of face `f` next to its corner `k`. */
  const interior = faces.map((face) =>
    face.map((v, k) => {
      const n = valence[v] as number;
      const next = at(face[(k + 1) % 4] as number);
      const previous = at(face[(k + 3) % 4] as number);
      const diagonal = at(face[(k + 2) % 4] as number);
      return scale3(add3(add3(scale3(at(v), n), scale3(add3(next, previous), 2)), diagonal), 1 / (n + 5));
    }),
  );
  /** Interior points around each vertex, and per directed edge v→w the two faces' points at v. */
  const around = vertices.map((): Vec3[] => []);
  const besideEdge = new Map<string, Vec3[]>();
  faces.forEach((face, f) =>
    face.forEach((v, k) => {
      const q = interior[f]?.[k] as Vec3;
      around[v]?.push(q);
      for (const w of [face[(k + 1) % 4] as number, face[(k + 3) % 4] as number]) {
        const list = besideEdge.get(`${v}>${w}`) ?? [];
        list.push(q);
        besideEdge.set(`${v}>${w}`, list);
      }
    }),
  );
  const hard = new Set((cage.vertexSharpness ?? []).filter((corner) => corner.s >= SHARP_MAX).map((corner) => corner.v));
  const corners = vertices.map((p, v): Vec3 => {
    const creases = creaseNeighbours[v] as number[];
    if (hard.has(v) || creases.length > 2) return p;
    if (creases.length === 2) {
      const [a, b] = creases.map(at) as [Vec3, Vec3];
      return scale3(add3(add3(a, b), scale3(p, 4)), 1 / 6);
    }
    const qs = around[v] as Vec3[];
    return scale3(sum(qs), 1 / qs.length);
  });
  /** Bézier point a third of the way along edge v→w (on v's side). */
  const edgePoint = (v: number, w: number): Vec3 => {
    if (sharp.has(edgeKey(v, w))) return scale3(add3(scale3(at(v), 2), at(w)), 1 / 3);
    const [first, second] = besideEdge.get(`${v}>${w}`) as [Vec3, Vec3];
    return scale3(add3(first, second), 0.5);
  };
  return faces.map((face, f) => {
    const [v0, v1, v2, v3] = face as [number, number, number, number];
    const q = interior[f] as Vec3[];
    const grid: Vec3[][] = [
      [corners[v0] as Vec3, edgePoint(v0, v3), edgePoint(v3, v0), corners[v3] as Vec3],
      [edgePoint(v0, v1), q[0] as Vec3, q[3] as Vec3, edgePoint(v3, v2)],
      [edgePoint(v1, v0), q[1] as Vec3, q[2] as Vec3, edgePoint(v2, v3)],
      [corners[v1] as Vec3, edgePoint(v1, v2), edgePoint(v2, v1), corners[v2] as Vec3],
    ];
    return grid.flat();
  });
}

/**
 * Bézier patches of a subdivision solid (local frame), from its cage refined `refine` times
 * (>= 1 so every face is a quad). One patch per refined face.
 */
export function subdivisionPatches(entity: Cage, refine = 1): BezierPatch[] {
  return quadCagePatches(subdivide(entity, Math.max(1, refine, settleLevels(entity))));
}

const bernstein = (t: number): [number, number, number, number] => {
  const s = 1 - t;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
};

/** Point of `patch` at (u, v) in [0, 1]². */
export function patchPoint(patch: BezierPatch, u: number, v: number): Vec3 {
  const bu = bernstein(u);
  const bv = bernstein(v);
  let point: Vec3 = [0, 0, 0];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) point = add3(point, scale3(patch[i * 4 + j] as Vec3, (bu[i] as number) * (bv[j] as number)));
  }
  return point;
}
