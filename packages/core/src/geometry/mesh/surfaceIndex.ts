/**
 * Closest-point index of an indexed triangle mesh (median-split AABB tree, leaf size 6): the nearest surface point, its distance and
 * triangle. Used by remeshing (projection onto the input), deviation measurement and shrink-wrapping.
 * @invariant same mesh -> same tree and answers (fixed traversal order, ties go to the lower triangle index)
 */

import type { Vec3 } from '../../model/vectors';
import { closestPointOnTriangle, rayTriangleDistance } from '../triangleQueries';

const LEAF = 6;

export interface SurfaceHit {
  readonly point: Vec3;
  readonly distance: number;
  readonly face: number;
}

export class SurfaceIndex {
  readonly faceCount: number;
  /** Triangle tests made by all `closest` calls so far (a work counter for callers with a budget). */
  tests = 0;
  private readonly corners: Float64Array;
  private readonly order: Int32Array;
  private readonly centres: Float64Array;
  private readonly boxes: number[] = [];
  private readonly left: number[] = [];
  private readonly right: number[] = [];
  private readonly start: number[] = [];
  private readonly end: number[] = [];

  constructor(positions: ReadonlyArray<number>, triangles: ReadonlyArray<number>) {
    this.faceCount = Math.floor(triangles.length / 3);
    this.corners = new Float64Array(this.faceCount * 9);
    for (let t = 0; t < this.faceCount; t++) {
      for (let k = 0; k < 3; k++)
        for (let axis = 0; axis < 3; axis++)
          this.corners[t * 9 + k * 3 + axis] = positions[(triangles[t * 3 + k] as number) * 3 + axis] as number;
    }
    this.order = Int32Array.from({ length: this.faceCount }, (_, i) => i);
    this.centres = new Float64Array(this.faceCount * 3);
    for (let t = 0; t < this.faceCount; t++) {
      for (let axis = 0; axis < 3; axis++) {
        const o = t * 9 + axis;
        this.centres[t * 3 + axis] = ((this.corners[o] as number) + (this.corners[o + 3] as number) + (this.corners[o + 6] as number)) / 3;
      }
    }
    if (this.faceCount > 0) this.build(0, this.faceCount);
  }

  private centre(t: number, axis: number): number {
    return this.centres[t * 3 + axis] as number;
  }

  private build(start: number, end: number): number {
    const node = this.left.length;
    this.left.push(-1);
    this.right.push(-1);
    this.start.push(start);
    this.end.push(end);
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const o = (this.order[i] as number) * 9;
      for (let k = 0; k < 9; k++) {
        const axis = k % 3;
        box[axis] = Math.min(box[axis] as number, this.corners[o + k] as number);
        box[axis + 3] = Math.max(box[axis + 3] as number, this.corners[o + k] as number);
      }
    }
    this.boxes.push(...box);
    if (end - start > LEAF) {
      const [ex, ey, ez] = [0, 1, 2].map((a) => (box[a + 3] as number) - (box[a] as number)) as [number, number, number];
      const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const slice = Array.from(this.order.subarray(start, end)).sort((x, y) => this.centre(x, axis) - this.centre(y, axis) || x - y);
      this.order.set(slice, start);
      const mid = (start + end) >> 1;
      this.left[node] = this.build(start, mid);
      this.right[node] = this.build(mid, end);
    }
    return node;
  }

  private boxDistanceSq(node: number, p: Vec3): number {
    let sum = 0;
    for (let a = 0; a < 3; a++) {
      const lo = this.boxes[node * 6 + a] as number;
      const hi = this.boxes[node * 6 + a + 3] as number;
      const x = p[a] as number;
      const d = x < lo ? lo - x : x > hi ? x - hi : 0;
      sum += d * d;
    }
    return sum;
  }

  /** Nearest surface point to `p` (distance Infinity and face -1 for an empty mesh). */
  closest(p: Vec3): SurfaceHit {
    let best: SurfaceHit = { point: p, distance: Infinity, face: -1 };
    if (this.faceCount === 0) return best;
    let bestSq = Infinity;
    const stack = [0];
    while (stack.length > 0) {
      const node = stack.pop() as number;
      if (this.boxDistanceSq(node, p) > bestSq) continue;
      if ((this.left[node] as number) < 0) {
        for (let i = this.start[node] as number; i < (this.end[node] as number); i++) {
          const t = this.order[i] as number;
          this.tests++;
          const o = t * 9;
          const c = this.corners;
          const hit = closestPointOnTriangle(p, [
            [c[o] as number, c[o + 1] as number, c[o + 2] as number],
            [c[o + 3] as number, c[o + 4] as number, c[o + 5] as number],
            [c[o + 6] as number, c[o + 7] as number, c[o + 8] as number],
          ]);
          const dSq = (hit[0] - p[0]) ** 2 + (hit[1] - p[1]) ** 2 + (hit[2] - p[2]) ** 2;
          if (dSq < bestSq || (dSq === bestSq && t < best.face)) {
            bestSq = dSq;
            best = { point: hit, distance: Math.sqrt(dSq), face: t };
          }
        }
      } else {
        const [l, r] = [this.left[node] as number, this.right[node] as number];
        const [dl, dr] = [this.boxDistanceSq(l, p), this.boxDistanceSq(r, p)];
        if (dl <= dr) stack.push(r, l);
        else stack.push(l, r);
      }
    }
    return best;
  }

  private rayHitsBox(node: number, origin: Vec3, inverse: Vec3, tMax: number): boolean {
    let near = 0;
    let far = tMax;
    for (let a = 0; a < 3; a++) {
      const lo = ((this.boxes[node * 6 + a] as number) - (origin[a] as number)) * (inverse[a] as number);
      const hi = ((this.boxes[node * 6 + a + 3] as number) - (origin[a] as number)) * (inverse[a] as number);
      if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
      near = Math.max(near, Math.min(lo, hi));
      far = Math.min(far, Math.max(lo, hi));
    }
    return near <= far * (1 + 1e-12) + 1e-12;
  }

  /** The first surface hit of the ray `origin + t * direction` (`direction` a unit vector) with t in [0, tMax]: its distance and triangle, or null (ties go to the lower triangle index). */
  ray(origin: Vec3, direction: Vec3, tMax: number): { readonly distance: number; readonly face: number } | null {
    if (this.faceCount === 0) return null;
    const inverse: Vec3 = [1 / direction[0], 1 / direction[1], 1 / direction[2]];
    let best: { distance: number; face: number } | null = null;
    let reach = tMax;
    const stack = [0];
    while (stack.length > 0) {
      const node = stack.pop() as number;
      if (!this.rayHitsBox(node, origin, inverse, reach)) continue;
      if ((this.left[node] as number) < 0) {
        for (let i = this.start[node] as number; i < (this.end[node] as number); i++) {
          const t = this.order[i] as number;
          const o = t * 9;
          const c = this.corners;
          const distance = rayTriangleDistance(
            origin,
            direction,
            [
              [c[o] as number, c[o + 1] as number, c[o + 2] as number],
              [c[o + 3] as number, c[o + 4] as number, c[o + 5] as number],
              [c[o + 6] as number, c[o + 7] as number, c[o + 8] as number],
            ],
            0,
            reach,
          );
          if (distance !== null && (best === null || distance < best.distance || (distance === best.distance && t < best.face))) {
            best = { distance, face: t };
            reach = distance;
          }
        }
      } else stack.push(this.right[node] as number, this.left[node] as number);
    }
    return best;
  }

  /** Barycentric weights of `point` in triangle `face` (assumes the point lies on it). */
  barycentric(face: number, point: Vec3): [number, number, number] {
    const c = this.corners;
    const o = face * 9;
    const a: Vec3 = [c[o] as number, c[o + 1] as number, c[o + 2] as number];
    const b: Vec3 = [c[o + 3] as number, c[o + 4] as number, c[o + 5] as number];
    const d: Vec3 = [c[o + 6] as number, c[o + 7] as number, c[o + 8] as number];
    const v0: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v1: Vec3 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const v2: Vec3 = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
    const dot = (x: Vec3, y: Vec3): number => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    const [d00, d01, d11, d20, d21] = [dot(v0, v0), dot(v0, v1), dot(v1, v1), dot(v2, v0), dot(v2, v1)];
    const denominator = d00 * d11 - d01 * d01;
    if (Math.abs(denominator) < 1e-300) return [1, 0, 0];
    const v = (d11 * d20 - d01 * d21) / denominator;
    const w = (d00 * d21 - d01 * d20) / denominator;
    return [1 - v - w, v, w];
  }
}
