/**
 * Patch refinement and fairing of a filled hole (Liepa 2003, stages 3 and 4): triangles whose centroid is farther from every corner than the
 * local edge length are split at the centroid and the new edges relaxed toward Delaunay; the inserted vertices are then moved to solve the
 * membrane (K x = 0, `tangent`) or thin-plate (K M^-1 K x = 0, `curvature`) equation with every other vertex fixed (K the cotangent stiffness matrix,
 * M the lumped mass). Conjugate gradients, relative residual 1e-10.
 * @invariant only inserted vertices move; the boundary loop and the rest of the mesh are bit-identical
 */

import type { Vec3 } from '../../model/vectors';
import type { EditMesh } from './editMesh';
import { normalOf } from './editMesh';

/** Liepa's density factor alpha (default sqrt 2): larger inserts more vertices. */
export const LIEPA_ALPHA = Math.SQRT2;
/** Hard cap on vertices a single patch may gain. */
const MAX_NEW_VERTICES = 4000;

export type Fairing = 'none' | 'tangent' | 'curvature';

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function cornerAngle(mesh: EditMesh, apex: number, a: number, b: number): number {
  const [p, pa, pb] = [mesh.p(apex), mesh.p(a), mesh.p(b)];
  const u: Vec3 = [pa[0] - p[0], pa[1] - p[1], pa[2] - p[2]];
  const v: Vec3 = [pb[0] - p[0], pb[1] - p[1], pb[2] - p[2]];
  const l = Math.hypot(...u) * Math.hypot(...v);
  return l > 0 ? Math.acos(Math.max(-1, Math.min(1, dot(u, v) / l))) : 0;
}

/** Swap interior patch edges while the opposite angles sum above pi (Delaunay) and the swap keeps both normals on the old side. */
function relaxEdges(mesh: EditMesh, patch: Set<number>, edges: Array<[number, number]>): void {
  const queue = [...edges];
  let guard = 50 * (queue.length + 10);
  while (queue.length > 0 && guard-- > 0) {
    const [a, b] = queue.shift() as [number, number];
    const shared = mesh.facesOnEdge(a, b);
    if (shared.length !== 2 || !shared.every((f) => patch.has(f))) continue;
    const [c, d] = [mesh.opposite(shared[0] as number, a, b), mesh.opposite(shared[1] as number, a, b)];
    if (c === d || mesh.facesOnEdge(c, d).length > 0) continue;
    if (cornerAngle(mesh, c, a, b) + cornerAngle(mesh, d, a, b) <= Math.PI + 1e-12) continue;
    const reference = mesh.faceNormal(shared[0] as number);
    const [pa, pb, pc, pd] = [mesh.p(a), mesh.p(b), mesh.p(c), mesh.p(d)];
    const flipFirst = mesh.hasDirected(shared[0] as number, a, b);
    const n1 = flipFirst ? normalOf(pa, pd, pc) : normalOf(pa, pc, pd);
    const n2 = flipFirst ? normalOf(pd, pb, pc) : normalOf(pc, pb, pd);
    if (dot(n1, reference) <= 0 || dot(n2, reference) <= 0) continue;
    mesh.flip(a, b);
    queue.push([a, c], [c, b], [b, d], [d, a]);
  }
}

/** Insert centroids until the patch density matches the surrounding mesh; returns the inserted vertex ids. */
export function refinePatch(mesh: EditMesh, patchFaces: Set<number>, sigma: Map<number, number>, alpha: number): number[] {
  const inserted: number[] = [];
  for (let pass = 0; pass < 12 && inserted.length < MAX_NEW_VERTICES; pass++) {
    let changed = false;
    for (const face of [...patchFaces].sort((x, y) => x - y)) {
      if (!patchFaces.has(face) || mesh.fAlive[face] !== true) continue;
      const [a, b, c] = mesh.corners(face);
      const [pa, pb, pc] = [mesh.p(a), mesh.p(b), mesh.p(c)];
      const centre: Vec3 = [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3];
      const [sa, sb, sc] = [sigma.get(a) as number, sigma.get(b) as number, sigma.get(c) as number];
      const sigmaCentre = (sa + sb + sc) / 3;
      const needed = (p: Vec3, s: number): boolean => alpha * dist(centre, p) > sigmaCentre && alpha * dist(centre, p) > s;
      if (!(needed(pa, sa) && needed(pb, sb) && needed(pc, sc))) continue;
      const v = mesh.addVertex(centre);
      sigma.set(v, sigmaCentre);
      inserted.push(v);
      mesh.setFace(face, a, b, v);
      patchFaces.add(mesh.addFace(b, c, v));
      patchFaces.add(mesh.addFace(c, a, v));
      relaxEdges(mesh, patchFaces, [
        [a, b],
        [b, c],
        [c, a],
      ]);
      changed = true;
      if (inserted.length >= MAX_NEW_VERTICES) break;
    }
    if (!changed) break;
  }
  return inserted;
}

export interface FairReport {
  readonly fairedVertices: number;
  readonly iterations: number;
  /** Largest relative residual over the three axes. */
  readonly residual: number;
  readonly converged: boolean;
}

interface FairSystem {
  readonly local: Map<number, number>;
  readonly neighbours: number[][];
  /** Cotangent edge weights, parallel to the neighbour lists. */
  readonly weights: number[][];
  /** Lumped mass (one third of the incident face areas) per local vertex. */
  readonly mass: number[];
  readonly rows: number[];
  readonly freeLocal: number[];
  readonly thinPlate: boolean;
}

const cot = (apex: Vec3, a: Vec3, b: Vec3): number => {
  const u: Vec3 = [a[0] - apex[0], a[1] - apex[1], a[2] - apex[2]];
  const v: Vec3 = [b[0] - apex[0], b[1] - apex[1], b[2] - apex[2]];
  const area2 = Math.hypot(...normalOf(apex, a, b));
  return area2 > 1e-300 ? dot(u, v) / area2 : 0;
};

function buildSystem(mesh: EditMesh, free: ReadonlyArray<number>, thinPlate: boolean): FairSystem {
  const involved = new Set<number>(free);
  for (const v of free) for (const w of mesh.ring(v)) involved.add(w);
  const everything = new Set<number>(involved);
  for (const v of involved) for (const w of mesh.ring(v)) everything.add(w);
  const ids = [...everything].sort((x, y) => x - y);
  const local = new Map<number, number>(ids.map((v, k) => [v, k]));
  const edgeWeight = new Map<number, number>();
  const mass = new Map<number, number>();
  const faces = new Set<number>();
  for (const v of involved) for (const f of mesh.vFaces[v] as Set<number>) faces.add(f);
  for (const f of faces) {
    const corners = mesh.corners(f);
    const points = corners.map((c) => mesh.p(c)) as [Vec3, Vec3, Vec3];
    const area = Math.hypot(...normalOf(...points)) / 2;
    for (let k = 0; k < 3; k++) {
      const [a, b] = [corners[(k + 1) % 3] as number, corners[(k + 2) % 3] as number];
      const key = Math.min(a, b) * 67_108_864 + Math.max(a, b);
      edgeWeight.set(
        key,
        (edgeWeight.get(key) ?? 0) + cot(points[k] as Vec3, points[(k + 1) % 3] as Vec3, points[(k + 2) % 3] as Vec3) / 2,
      );
      mass.set(corners[k] as number, (mass.get(corners[k] as number) ?? 0) + area / 3);
    }
  }
  const rings = ids.map((v) => (involved.has(v) ? mesh.ring(v) : []));
  return {
    local,
    neighbours: rings.map((ring) => ring.map((w) => local.get(w) as number)),
    weights: rings.map((ring, k) =>
      ring.map((w) => edgeWeight.get(Math.min(w, ids[k] as number) * 67_108_864 + Math.max(w, ids[k] as number)) ?? 0),
    ),
    mass: ids.map((v) => Math.max(mass.get(v) ?? 0, 1e-300)),
    rows: [...involved].map((v) => local.get(v) as number),
    freeLocal: free.map((v) => local.get(v) as number),
    thinPlate,
  };
}

function umbrella(system: FairSystem, x: Float64Array, rows: ReadonlyArray<number>, scaled: boolean): Float64Array {
  const out = new Float64Array(x.length);
  for (const k of rows) {
    const ring = system.neighbours[k] as number[];
    const weights = system.weights[k] as number[];
    let sum = 0;
    ring.forEach((w, n) => (sum += (weights[n] as number) * ((x[k] as number) - (x[w] as number))));
    out[k] = scaled ? sum / (system.mass[k] as number) : sum;
  }
  return out;
}

/** The fairing operator on a full-length vector, evaluated on the free rows only. */
function operator(system: FairSystem, x: Float64Array): Float64Array {
  const first = umbrella(system, x, system.rows, system.thinPlate);
  return system.thinPlate ? umbrella(system, first, system.freeLocal, false) : first;
}

/** Solve the fairing equation for `free` vertices (all others fixed). */
export function fairVertices(mesh: EditMesh, free: ReadonlyArray<number>, fairing: Exclude<Fairing, 'none'>): FairReport {
  if (free.length === 0) return { fairedVertices: 0, iterations: 0, residual: 0, converged: true };
  const system = buildSystem(mesh, free, fairing === 'curvature');
  const size = system.local.size;
  const columns: number[][] = [[], [], []];
  let iterations = 0;
  let residual = 0;
  let converged = true;
  const ids = [...system.local.keys()];
  const freeSet = new Set(free);
  for (let axis = 0; axis < 3; axis++) {
    const fixedOnly = new Float64Array(size);
    ids.forEach((v, k) => (fixedOnly[k] = freeSet.has(v) ? 0 : (mesh.pos[v * 3 + axis] as number)));
    const rhsFull = operator(system, fixedOnly);
    const b = system.freeLocal.map((k) => -(rhsFull[k] as number));
    const norm = Math.hypot(...b);
    const place = (values: ReadonlyArray<number>): Float64Array => {
      const x = new Float64Array(size);
      system.freeLocal.forEach((k, i) => (x[k] = values[i] as number));
      return x;
    };
    const apply = (values: ReadonlyArray<number>): number[] => {
      const y = operator(system, place(values));
      return system.freeLocal.map((k) => y[k] as number);
    };
    let x = free.map((v) => mesh.pos[v * 3 + axis] as number);
    let r = apply(x).map((value, i) => (b[i] as number) - value);
    let p = [...r];
    let rr = r.reduce((s, v) => s + v * v, 0);
    let count = 0;
    const limit = 20 * free.length + 500;
    while (Math.sqrt(rr) > 1e-10 * Math.max(norm, 1e-300) && count < limit) {
      const ap = apply(p);
      const denominator = p.reduce((s, v, i) => s + v * (ap[i] as number), 0);
      if (!(denominator > 0)) break;
      const alpha = rr / denominator;
      x = x.map((v, i) => v + alpha * (p[i] as number));
      r = r.map((v, i) => v - alpha * (ap[i] as number));
      const next = r.reduce((s, v) => s + v * v, 0);
      p = p.map((v, i) => (r[i] as number) + (next / rr) * v);
      rr = next;
      count++;
    }
    iterations += count;
    residual = Math.max(residual, norm > 0 ? Math.sqrt(rr) / norm : Math.sqrt(rr));
    converged = converged && Math.sqrt(rr) <= 1e-9 * Math.max(norm, 1e-300);
    columns[axis] = x;
  }
  free.forEach((v, i) =>
    mesh.setP(v, [(columns[0] as number[])[i] as number, (columns[1] as number[])[i] as number, (columns[2] as number[])[i] as number]),
  );
  return { fairedVertices: free.length, iterations, residual, converged };
}
