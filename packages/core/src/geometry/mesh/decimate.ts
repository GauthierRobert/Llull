/**
 * Quadric-error-metric decimation (Garland and Heckbert 1997) with the 07 MSH stop rules: a triangle target and / or an absolute one-sided
 * deviation bound. Edge collapses only (no virtual pairs), lowest cost first with the ties broken by vertex ids, boundary vertices locked or
 * penalised, link condition + fold-over + sliver checks, and probe points (every original vertex and face centroid) that must stay within
 * `maxDeviation` of the faces of their current owner vertex.
 * @invariant a collapse never creates a fold-over, a non-manifold edge or a face of vanishing area
 * @invariant with maxDeviation, every original vertex and face centroid ends within maxDeviation of the result (checked per collapse; the
 *            command re-measures it both ways)
 */

import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { EditMesh, normalOf } from './editMesh';
import { meshDiagonal } from './weld';
import { type SphereRegion, insideRegion } from './region';
import { SurfaceIndex } from './surfaceIndex';

export interface DecimateParams {
  readonly targetTriangles?: number;
  readonly maxDeviation?: number;
  readonly preserveBoundary: boolean;
  readonly featureAngleRad?: number;
  /** Vertices inside this sphere never move or disappear. */
  readonly lockedRegion?: SphereRegion;
}

export interface DecimateReport {
  readonly trianglesBefore: number;
  readonly trianglesAfter: number;
  readonly collapses: number;
  readonly reachedTarget: boolean | null;
  readonly stoppedBy: 'target' | 'deviation_or_validity' | 'exhausted';
  readonly rejected: { readonly link: number; readonly foldOver: number; readonly deviation: number };
  /** Largest cost of a collapse made; null when a NaN cost (overflowing quadrics) was collapsed (JSON has no NaN). */
  readonly maxCollapseCost: number | null;
}

const PENALTY = 1000;

type Quadric = Float64Array;

/** Plane quadric K = p p^T of the plane a x + b y + c z + d = 0 (unit normal), scaled by `weight`. */
function planeQuadric(n: Vec3, point: Vec3, weight: number): Quadric {
  const d = -(n[0] * point[0] + n[1] * point[1] + n[2] * point[2]);
  const p = [n[0], n[1], n[2], d];
  const q = new Float64Array(10);
  let k = 0;
  for (let i = 0; i < 4; i++) for (let j = i; j < 4; j++) q[k++] = weight * (p[i] as number) * (p[j] as number);
  return q;
}

function addInto(target: Quadric, source: Quadric): void {
  for (let i = 0; i < 10; i++) target[i] = (target[i] as number) + (source[i] as number);
}

function quadricCost(q: Quadric, x: number, y: number, z: number): number {
  const g = (i: number): number => q[i] as number;
  return (
    g(0) * x * x +
    2 * g(1) * x * y +
    2 * g(2) * x * z +
    2 * g(3) * x +
    g(4) * y * y +
    2 * g(5) * y * z +
    2 * g(6) * y +
    g(7) * z * z +
    2 * g(8) * z +
    g(9)
  );
}

/** Minimiser of the quadric, or null when the 3x3 system is (nearly) singular. */
function optimalPosition(q: Quadric): Vec3 | null {
  const g = (i: number): number => q[i] as number;
  const [a, b, c, d, e, f] = [g(0), g(1), g(2), g(4), g(5), g(7)];
  const det = a * (d * f - e * e) - b * (b * f - c * e) + c * (b * e - c * d);
  const trace = a + d + f;
  if (!(Math.abs(det) > 1e-12 * (trace * trace * trace))) return null;
  const rhs: Vec3 = [-g(3), -g(6), -g(8)];
  const inv: Vec3[] = [
    [d * f - e * e, c * e - b * f, b * e - c * d],
    [c * e - b * f, a * f - c * c, b * c - a * e],
    [b * e - c * d, b * c - a * e, a * d - b * b],
  ];
  const solve = (row: Vec3): number => (row[0] * rhs[0] + row[1] * rhs[1] + row[2] * rhs[2]) / det;
  return [solve(inv[0] as Vec3), solve(inv[1] as Vec3), solve(inv[2] as Vec3)];
}

/** Squared distance from p to triangle abc (Ericson 5.1.5), allocation free. */
function pointTriangleSq(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const apz = p[2] - a[2];
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  const sq = (x: number, y: number, z: number): number => x * x + y * y + z * z;
  if (d1 <= 0 && d2 <= 0) return sq(apx, apy, apz);
  const bpx = p[0] - b[0];
  const bpy = p[1] - b[1];
  const bpz = p[2] - b[2];
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return sq(bpx, bpy, bpz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return sq(apx - v * abx, apy - v * aby, apz - v * abz);
  }
  const cpx = p[0] - c[0];
  const cpy = p[1] - c[1];
  const cpz = p[2] - c[2];
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return sq(cpx, cpy, cpz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return sq(apx - w * acx, apy - w * acy, apz - w * acz);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return sq(bpx - w * (c[0] - b[0]), bpy - w * (c[1] - b[1]), bpz - w * (c[2] - b[2]));
  }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return sq(apx - v * abx - w * acx, apy - v * aby - w * acy, apz - v * abz - w * acz);
}

/** A heap entry. The vertex kept and its position are not stored: they are a pure function of the two vertices' quadrics and positions, which are unchanged while the versions match, so `choose` recomputes the same answer when the entry is popped. */
interface Candidate {
  cost: number;
  a: number;
  b: number;
  versionA: number;
  versionB: number;
}

class Heap {
  private readonly items: Candidate[] = [];
  get size(): number {
    return this.items.length;
  }
  /** Lower cost first, then lower a, then lower b; a NaN cost (overflowing quadrics) counts as +Infinity, so the order is total and does not depend on the heap's shape. */
  private less(x: Candidate, y: Candidate): boolean {
    const [cx, cy] = [Number.isNaN(x.cost) ? Infinity : x.cost, Number.isNaN(y.cost) ? Infinity : y.cost];
    return cx < cy || (cx === cy && (x.a < y.a || (x.a === y.a && x.b < y.b)));
  }
  push(item: Candidate): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(items[i] as Candidate, items[parent] as Candidate)) break;
      [items[i], items[parent]] = [items[parent] as Candidate, items[i] as Candidate];
      i = parent;
    }
  }
  pop(): Candidate | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (top === undefined || last === undefined) return top;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const [l, r] = [2 * i + 1, 2 * i + 2];
        let smallest = i;
        if (l < items.length && this.less(items[l] as Candidate, items[smallest] as Candidate)) smallest = l;
        if (r < items.length && this.less(items[r] as Candidate, items[smallest] as Candidate)) smallest = r;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest] as Candidate, items[i] as Candidate];
        i = smallest;
      }
    }
    return top;
  }
}

/** Decimate a manifold, consistently wound, welded mesh. */
export function decimateMesh(input: MeshData, params: DecimateParams): { mesh: MeshData; report: DecimateReport } {
  const mesh = new EditMesh(input.positions, input.indices);
  const trianglesBefore = mesh.liveFaces;
  const diagonal = meshDiagonal(input.positions);
  const areaFloor = 1e-12 * diagonal * diagonal;
  const target = params.targetTriangles ?? 0;
  const quadrics: Quadric[] = Array.from({ length: mesh.vertexTotal }, () => new Float64Array(10));
  const unitNormal = (f: number): Vec3 | null => {
    const n = mesh.faceNormal(f);
    const l = Math.hypot(...n);
    return l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : null;
  };
  for (let f = 0; f < mesh.fAlive.length; f++) {
    const n = unitNormal(f);
    if (n === null) continue;
    const [a, b, c] = mesh.corners(f);
    const k = planeQuadric(n, mesh.p(a), 1);
    for (const v of [a, b, c]) addInto(quadrics[v] as Quadric, k);
  }
  const locked = new Uint8Array(mesh.vertexTotal);
  const boundaryEdges: Array<[number, number, number]> = [];
  const featureEdges: Array<[number, number, number, number]> = [];
  const cosFeature = params.featureAngleRad === undefined ? null : Math.cos(params.featureAngleRad);
  for (let a = 0; a < mesh.vertexTotal; a++) {
    for (const b of mesh.ring(a)) {
      if (b < a) continue;
      const shared = mesh.facesOnEdge(a, b);
      if (shared.length === 1) boundaryEdges.push([a, b, shared[0] as number]);
      else if (shared.length === 2 && cosFeature !== null) {
        const [n1, n2] = [unitNormal(shared[0] as number), unitNormal(shared[1] as number)];
        if (n1 !== null && n2 !== null && n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] < cosFeature)
          featureEdges.push([a, b, shared[0] as number, shared[1] as number]);
      }
    }
  }
  const penalise = (a: number, b: number, face: number): void => {
    const n = unitNormal(face);
    if (n === null) return;
    const [pa, pb] = [mesh.p(a), mesh.p(b)];
    const edge: Vec3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const side = normalOf([0, 0, 0], edge, n);
    const l = Math.hypot(...side);
    if (l === 0) return;
    const k = planeQuadric([side[0] / l, side[1] / l, side[2] / l], pa, PENALTY);
    addInto(quadrics[a] as Quadric, k);
    addInto(quadrics[b] as Quadric, k);
  };
  for (const [a, b, face] of boundaryEdges) {
    if (params.preserveBoundary) {
      locked[a] = 1;
      locked[b] = 1;
    } else penalise(a, b, face);
  }
  for (const [a, b, f1, f2] of featureEdges) {
    penalise(a, b, f1);
    penalise(a, b, f2);
  }
  if (params.lockedRegion !== undefined) {
    for (let v = 0; v < mesh.vertexTotal; v++) if (insideRegion(params.lockedRegion, mesh.p(v))) locked[v] = 1;
  }
  // Probes for the deviation bound.
  const maxDeviation = params.maxDeviation;
  const probes: Vec3[] = [];
  const owned: number[][] = Array.from({ length: mesh.vertexTotal }, () => []);
  if (maxDeviation !== undefined) {
    for (let v = 0; v < mesh.vertexTotal; v++) {
      if ((mesh.vFaces[v] as Set<number>).size === 0) continue;
      probes.push(mesh.p(v));
      (owned[v] as number[]).push(probes.length - 1);
    }
    for (let f = 0; f < mesh.fAlive.length; f++) {
      const [a, b, c] = mesh.corners(f).map((v) => mesh.p(v)) as [Vec3, Vec3, Vec3];
      probes.push([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]);
      (owned[mesh.corners(f)[0]] as number[]).push(probes.length - 1);
    }
  }
  const original = maxDeviation === undefined ? null : new SurfaceIndex(input.positions, input.indices);
  const version = new Int32Array(mesh.vertexTotal);
  const heap = new Heap();
  const rejected = { link: 0, foldOver: 0, deviation: 0 };

  /** The vertex that survives collapsing the edge a-b (a < b), where it goes, and the quadric cost there. */
  const choose = (a: number, b: number): { keep: number; at: Vec3; cost: number } => {
    const sum = new Float64Array(10);
    addInto(sum, quadrics[a] as Quadric);
    addInto(sum, quadrics[b] as Quadric);
    const options: Array<{ keep: number; at: Vec3 }> = [];
    if (locked[a] === 1) options.push({ keep: a, at: mesh.p(a) });
    else if (locked[b] === 1) options.push({ keep: b, at: mesh.p(b) });
    else {
      const [pa, pb] = [mesh.p(a), mesh.p(b)];
      const optimal = optimalPosition(sum);
      const mid: Vec3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
      const length = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
      if (optimal !== null && Math.hypot(optimal[0] - mid[0], optimal[1] - mid[1], optimal[2] - mid[2]) <= 2 * length)
        options.push({ keep: a, at: optimal });
      options.push({ keep: a, at: pa }, { keep: b, at: pb }, { keep: a, at: mid });
    }
    let best = options[0] as { keep: number; at: Vec3 };
    let bestCost = quadricCost(sum, best.at[0], best.at[1], best.at[2]);
    for (const option of options.slice(1)) {
      const cost = quadricCost(sum, option.at[0], option.at[1], option.at[2]);
      if (cost < bestCost - 1e-18) {
        best = option;
        bestCost = cost;
      }
    }
    return { keep: best.keep, at: best.at, cost: bestCost };
  };

  const push = (a: number, b: number): void => {
    if (a > b) [a, b] = [b, a];
    if (locked[a] === 1 && locked[b] === 1) return;
    heap.push({ cost: Math.max(0, choose(a, b).cost), a, b, versionA: version[a] as number, versionB: version[b] as number });
  };
  for (let a = 0; a < mesh.vertexTotal; a++) for (const b of mesh.ring(a)) if (a < b) push(a, b);

  /** Faces around `u` and `b` after u merges into `k` at `at`, as vertex-id triples with positions. */
  const validCollapse = (u: number, v: number, keep: number, at: Vec3): 'ok' | 'link' | 'foldOver' | 'deviation' => {
    const edgeFaces = mesh.facesOnEdge(u, v);
    if (edgeFaces.length < 1 || edgeFaces.length > 2) return 'link';
    const [ringU, ringV] = [mesh.ring(u), mesh.ring(v)];
    const common = ringU.filter((w) => ringV.includes(w));
    const apexes = edgeFaces.map((f) => mesh.opposite(f, u, v)).sort((x, y) => x - y);
    if (common.length !== apexes.length || common.some((w, i) => w !== apexes[i])) return 'link';
    if (!mesh.isBoundaryEdge(u, v) && mesh.isBoundaryVertex(u) && mesh.isBoundaryVertex(v)) return 'link';
    if (edgeFaces.length === 2 && new Set([...ringU, ...ringV]).size - 2 <= 3) return 'link';
    const removed = keep === u ? v : u;
    const fan: Array<[number, number, number]> = [];
    for (const w of [u, v]) {
      for (const f of mesh.vFaces[w] as Set<number>) {
        if (edgeFaces.includes(f)) continue;
        const [x, y, z] = mesh.corners(f);
        const swap = (c: number): number => (c === removed ? keep : c);
        const before = normalOf(mesh.p(x), mesh.p(y), mesh.p(z));
        const pos = (c: number): Vec3 => (swap(c) === keep ? at : mesh.p(c));
        const after = normalOf(pos(x), pos(y), pos(z));
        const dotNormals = before[0] * after[0] + before[1] * after[1] + before[2] * after[2];
        // a normal or an area that is not a number (overflow) is no proof that the triangle survives: refused as a fold-over
        const area = Math.hypot(...after) / 2;
        if (!(dotNormals > 0) || !(area > areaFloor)) return 'foldOver';
        fan.push([swap(x), swap(y), swap(z)]);
      }
    }
    if (maxDeviation === undefined) return 'ok';
    const affected = new Set<number>([keep, ...ringU, ...ringV]);
    affected.delete(removed);
    const limit = maxDeviation * maxDeviation;
    if (original !== null) {
      // Backward bound: the new vertex and the new faces' centroids stay close to the original surface.
      if (original.closest(at).distance > maxDeviation) return 'deviation';
      for (const [x, y, z] of fan) {
        const pos = (c: number): Vec3 => (c === keep ? at : mesh.p(c));
        const [pa, pb, pc] = [pos(x), pos(y), pos(z)];
        const centre: Vec3 = [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3];
        if (original.closest(centre).distance > maxDeviation) return 'deviation';
      }
    }
    for (const o of affected) {
      const faces: Array<[Vec3, Vec3, Vec3]> = [];
      for (const f of mesh.vFaces[o] as Set<number>) {
        const [x, y, z] = mesh.corners(f);
        if (x === u || x === v || y === u || y === v || z === u || z === v) continue;
        faces.push([mesh.p(x), mesh.p(y), mesh.p(z)]);
      }
      const pos = (c: number): Vec3 => (c === keep ? at : mesh.p(c));
      for (const triple of fan) if (triple.includes(o)) faces.push([pos(triple[0]), pos(triple[1]), pos(triple[2])]);
      const owners = o === keep ? [...(owned[keep] as number[]), ...(owned[removed] as number[])] : (owned[o] as number[]);
      for (const probe of owners) {
        const p = probes[probe] as Vec3;
        let nearest = Infinity;
        for (const [a, b, c] of faces) nearest = Math.min(nearest, pointTriangleSq(p, a, b, c));
        if (nearest > limit) return 'deviation';
      }
    }
    return 'ok';
  };

  let collapses = 0;
  let maxCost = 0;
  while (heap.size > 0) {
    if (target > 0 && mesh.liveFaces <= target) break;
    const item = heap.pop() as Candidate;
    const { a, b } = item;
    if (mesh.vAlive[a] !== true || mesh.vAlive[b] !== true) continue;
    if (version[a] !== item.versionA || version[b] !== item.versionB) continue;
    if (mesh.facesOnEdge(a, b).length === 0) continue;
    const { keep, at } = choose(a, b);
    const verdict = validCollapse(a, b, keep, at);
    if (verdict !== 'ok') {
      rejected[verdict]++;
      continue;
    }
    const removed = keep === a ? b : a;
    const kept = keep;
    const sum = quadrics[kept] as Quadric;
    addInto(sum, quadrics[removed] as Quadric);
    mesh.setP(kept, at);
    mesh.collapse(removed, kept);
    (owned[kept] as number[]).push(...(owned[removed] as number[]));
    owned[removed] = [];
    if (locked[removed] === 1) locked[kept] = 1;
    collapses++;
    maxCost = Math.max(maxCost, item.cost);
    const refresh = [kept, ...mesh.ring(kept)];
    for (const w of refresh) version[w] = (version[w] as number) + 1;
    const refreshed = new Set(refresh);
    for (const w of refresh) for (const x of mesh.ring(w)) if (w < x || !refreshed.has(x)) push(w, x);
  }
  const trianglesAfter = mesh.liveFaces;
  const reached = params.targetTriangles === undefined ? null : trianglesAfter <= params.targetTriangles;
  return {
    mesh: mesh.toMeshData(),
    report: {
      trianglesBefore,
      trianglesAfter,
      collapses,
      reachedTarget: reached,
      stoppedBy:
        target > 0 && trianglesAfter <= target
          ? 'target'
          : params.maxDeviation !== undefined && heap.size === 0 && rejected.deviation > 0
            ? 'deviation_or_validity'
            : 'exhausted',
      rejected,
      maxCollapseCost: Number.isNaN(maxCost) ? null : maxCost,
    },
  };
}
