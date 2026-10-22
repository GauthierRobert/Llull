/**
 * Distance and inside/outside field of a triangle mesh: a median-split BVH in typed arrays answers the unsigned distance (point-triangle,
 * branch and bound) and the generalized winding number (exact solid angle near, area-weighted dipole far, after Jacobson et al. 2013 and
 * Barill et al. 2018), so soups with overlaps or holes still classify points. Feeds level-set offset, hollow and wrap.
 * @invariant allocation-free queries (they run a million times per level set); same mesh -> same tree and answers
 */

import type { Vec3 } from '../../model/vectors';

const LEAF_SIZE = 4;
const STACK_SIZE = 128;
/** A node is replaced by its dipole when the query is farther than this many node radii from its centroid. */
const DIPOLE_RATIO = 2.5;

export class MeshField {
  readonly triangleCount: number;
  private readonly corners: Float64Array;
  private readonly order: Int32Array;
  private nodeCount = 0;
  private readonly boxes: Float64Array;
  private readonly left: Int32Array;
  private readonly right: Int32Array;
  private readonly start: Int32Array;
  private readonly end: Int32Array;
  /** Per node: area-weighted normal sum (3), centroid (3), radius (1). */
  private readonly dipole: Float64Array;
  private readonly stack = new Int32Array(STACK_SIZE);

  constructor(positions: ReadonlyArray<number>, triangles: ReadonlyArray<number>) {
    this.triangleCount = Math.floor(triangles.length / 3);
    this.corners = new Float64Array(this.triangleCount * 9);
    for (let t = 0; t < this.triangleCount; t++) {
      for (let k = 0; k < 3; k++) {
        for (let axis = 0; axis < 3; axis++)
          this.corners[t * 9 + k * 3 + axis] = positions[(triangles[t * 3 + k] as number) * 3 + axis] as number;
      }
    }
    this.order = Int32Array.from({ length: this.triangleCount }, (_, i) => i);
    const capacity = Math.max(1, 2 * this.triangleCount);
    this.boxes = new Float64Array(capacity * 6);
    this.left = new Int32Array(capacity).fill(-1);
    this.right = new Int32Array(capacity).fill(-1);
    this.start = new Int32Array(capacity);
    this.end = new Int32Array(capacity);
    this.dipole = new Float64Array(capacity * 7);
    if (this.triangleCount > 0) this.build(0, this.triangleCount);
  }

  private build(start: number, end: number): number {
    const node = this.nodeCount++;
    const box = node * 6;
    let [minX, minY, minZ] = [Infinity, Infinity, Infinity];
    let [maxX, maxY, maxZ] = [-Infinity, -Infinity, -Infinity];
    let area = 0;
    let [nx, ny, nz, cx, cy, cz] = [0, 0, 0, 0, 0, 0];
    const c = this.corners;
    for (let i = start; i < end; i++) {
      const o = (this.order[i] as number) * 9;
      for (let k = 0; k < 9; k += 3) {
        minX = Math.min(minX, c[o + k] as number);
        maxX = Math.max(maxX, c[o + k] as number);
        minY = Math.min(minY, c[o + k + 1] as number);
        maxY = Math.max(maxY, c[o + k + 1] as number);
        minZ = Math.min(minZ, c[o + k + 2] as number);
        maxZ = Math.max(maxZ, c[o + k + 2] as number);
      }
      const [ux, uy, uz] = [
        (c[o + 3] as number) - (c[o] as number),
        (c[o + 4] as number) - (c[o + 1] as number),
        (c[o + 5] as number) - (c[o + 2] as number),
      ];
      const [vx, vy, vz] = [
        (c[o + 6] as number) - (c[o] as number),
        (c[o + 7] as number) - (c[o + 1] as number),
        (c[o + 8] as number) - (c[o + 2] as number),
      ];
      const [ax, ay, az] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const triangleArea = Math.hypot(ax, ay, az) / 2;
      area += triangleArea;
      nx += ax / 2;
      ny += ay / 2;
      nz += az / 2;
      cx += (triangleArea * ((c[o] as number) + (c[o + 3] as number) + (c[o + 6] as number))) / 3;
      cy += (triangleArea * ((c[o + 1] as number) + (c[o + 4] as number) + (c[o + 7] as number))) / 3;
      cz += (triangleArea * ((c[o + 2] as number) + (c[o + 5] as number) + (c[o + 8] as number))) / 3;
    }
    this.boxes.set([minX, minY, minZ, maxX, maxY, maxZ], box);
    const [mx, my, mz] = area > 0 ? [cx / area, cy / area, cz / area] : [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
    const radius = Math.hypot(Math.max(maxX - mx, mx - minX), Math.max(maxY - my, my - minY), Math.max(maxZ - mz, mz - minZ));
    this.dipole.set([nx, ny, nz, mx, my, mz, radius], node * 7);
    this.start[node] = start;
    this.end[node] = end;
    if (end - start <= LEAF_SIZE) return node;
    const extent = [maxX - minX, maxY - minY, maxZ - minZ] as [number, number, number];
    const axis = extent[0] >= extent[1] && extent[0] >= extent[2] ? 0 : extent[1] >= extent[2] ? 1 : 2;
    const keyOf = (t: number): number =>
      ((c[t * 9 + axis] as number) + (c[t * 9 + 3 + axis] as number) + (c[t * 9 + 6 + axis] as number)) / 3;
    const slice = Array.from(this.order.subarray(start, end)).sort((x, y) => keyOf(x) - keyOf(y) || x - y);
    this.order.set(slice, start);
    const middle = (start + end) >> 1;
    this.left[node] = this.build(start, middle);
    this.right[node] = this.build(middle, end);
    return node;
  }

  private triangleDistanceSq(t: number, px: number, py: number, pz: number): number {
    const c = this.corners;
    const o = t * 9;
    const [ax, ay, az] = [c[o] as number, c[o + 1] as number, c[o + 2] as number];
    const [abx, aby, abz] = [(c[o + 3] as number) - ax, (c[o + 4] as number) - ay, (c[o + 5] as number) - az];
    const [acx, acy, acz] = [(c[o + 6] as number) - ax, (c[o + 7] as number) - ay, (c[o + 8] as number) - az];
    const [apx, apy, apz] = [px - ax, py - ay, pz - az];
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    let s = 0;
    let u = 0;
    if (d1 > 0 || d2 > 0) {
      const [bpx, bpy, bpz] = [px - (c[o + 3] as number), py - (c[o + 4] as number), pz - (c[o + 5] as number)];
      const d3 = abx * bpx + aby * bpy + abz * bpz;
      const d4 = acx * bpx + acy * bpy + acz * bpz;
      const vc = d1 * d4 - d3 * d2;
      if (d3 >= 0 && d4 <= d3) [s, u] = [1, 0];
      else if (vc <= 0 && d1 >= 0 && d3 <= 0) [s, u] = [d1 / (d1 - d3), 0];
      else {
        const [cpx, cpy, cpz] = [px - (c[o + 6] as number), py - (c[o + 7] as number), pz - (c[o + 8] as number)];
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        const vb = d5 * d2 - d1 * d6;
        if (d6 >= 0 && d5 <= d6) [s, u] = [0, 1];
        else if (vb <= 0 && d2 >= 0 && d6 <= 0) [s, u] = [0, d2 / (d2 - d6)];
        else {
          const va = d3 * d6 - d5 * d4;
          if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
            const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
            [s, u] = [1 - w, w];
          } else {
            const denominator = 1 / (va + vb + vc);
            [s, u] = [vb * denominator, vc * denominator];
          }
        }
      }
    }
    const [dx, dy, dz] = [ax + s * abx + u * acx - px, ay + s * aby + u * acy - py, az + s * abz + u * acz - pz];
    return dx * dx + dy * dy + dz * dz;
  }

  private boxGapSq(node: number, px: number, py: number, pz: number): number {
    const b = node * 6;
    const gx = Math.max((this.boxes[b] as number) - px, 0, px - (this.boxes[b + 3] as number));
    const gy = Math.max((this.boxes[b + 1] as number) - py, 0, py - (this.boxes[b + 4] as number));
    const gz = Math.max((this.boxes[b + 2] as number) - pz, 0, pz - (this.boxes[b + 5] as number));
    return gx * gx + gy * gy + gz * gz;
  }

  /** Unsigned distance from `p` to the nearest triangle (Infinity for an empty mesh). */
  distance(p: Vec3): number {
    if (this.triangleCount === 0) return Infinity;
    const [px, py, pz] = p;
    let best = Infinity;
    const stack = this.stack;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const node = stack[--top] as number;
      const b = node * 6;
      const gx = Math.max((this.boxes[b] as number) - px, 0, px - (this.boxes[b + 3] as number));
      const gy = Math.max((this.boxes[b + 1] as number) - py, 0, py - (this.boxes[b + 4] as number));
      const gz = Math.max((this.boxes[b + 2] as number) - pz, 0, pz - (this.boxes[b + 5] as number));
      if (gx * gx + gy * gy + gz * gz >= best) continue;
      const l = this.left[node] as number;
      if (l < 0) {
        for (let i = this.start[node] as number; i < (this.end[node] as number); i++) {
          const d = this.triangleDistanceSq(this.order[i] as number, px, py, pz);
          if (d < best) best = d;
        }
      } else {
        const r = this.right[node] as number;
        // nearer child popped first: the bound tightens before the far child is tested
        if (this.boxGapSq(l, px, py, pz) <= this.boxGapSq(r, px, py, pz)) {
          stack[top++] = r;
          stack[top++] = l;
        } else {
          stack[top++] = l;
          stack[top++] = r;
        }
      }
    }
    return Math.sqrt(best);
  }

  /** Generalized winding number at `p`: 1 inside a closed outward-wound mesh, 0 outside, fractional near gaps. */
  winding(p: Vec3): number {
    if (this.triangleCount === 0) return 0;
    const [px, py, pz] = p;
    let sum = 0;
    const stack = this.stack;
    const c = this.corners;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const node = stack[--top] as number;
      const d = node * 7;
      const [dx, dy, dz] = [(this.dipole[d + 3] as number) - px, (this.dipole[d + 4] as number) - py, (this.dipole[d + 5] as number) - pz];
      const distance = Math.hypot(dx, dy, dz);
      if (distance > DIPOLE_RATIO * (this.dipole[d + 6] as number)) {
        sum +=
          ((this.dipole[d] as number) * dx + (this.dipole[d + 1] as number) * dy + (this.dipole[d + 2] as number) * dz) /
          (distance * distance * distance);
        continue;
      }
      const l = this.left[node] as number;
      if (l >= 0) {
        stack[top++] = this.right[node] as number;
        stack[top++] = l;
        continue;
      }
      for (let i = this.start[node] as number; i < (this.end[node] as number); i++) {
        const o = (this.order[i] as number) * 9;
        const [ax, ay, az] = [(c[o] as number) - px, (c[o + 1] as number) - py, (c[o + 2] as number) - pz];
        const [bx, by, bz] = [(c[o + 3] as number) - px, (c[o + 4] as number) - py, (c[o + 5] as number) - pz];
        const [cx, cy, cz] = [(c[o + 6] as number) - px, (c[o + 7] as number) - py, (c[o + 8] as number) - pz];
        const [la, lb, lc] = [Math.hypot(ax, ay, az), Math.hypot(bx, by, bz), Math.hypot(cx, cy, cz)];
        const triple = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
        const denominator =
          la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (ax * cx + ay * cy + az * cz) * lb + (bx * cx + by * cy + bz * cz) * la;
        sum += 2 * Math.atan2(triple, denominator);
      }
    }
    return sum / (4 * Math.PI);
  }

  /** Signed distance, negative inside (winding number above 1/2), positive outside. */
  signedDistance(p: Vec3): number {
    const distance = this.distance(p);
    return this.winding(p) > 0.5 ? -distance : distance;
  }
}
