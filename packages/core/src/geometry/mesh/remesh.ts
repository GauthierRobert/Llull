/**
 * Isotropic and adaptive remeshing (Botsch and Kobbelt 2004, 07 MSH FR-MSH-09). Per iteration: split edges longer than 4/3 L, collapse edges
 * shorter than 4/5 L, flip toward valence 6 (4 on constraints), relax tangentially, project onto the input surface. Feature edges (dihedral
 * above the feature angle) and, with `preserveBoundary`, boundary vertices keep their place; feature vertices slide along their line, corner
 * vertices are fixed. The target length is constant (isotropic) or follows the local curvature (adaptive, chord error `approxError`).
 * @invariant the closing pass splits until no edge exceeds 4/3 L, so the maximum edge never exceeds the band
 * @invariant never creates a fold-over or non-manifold edge
 */

import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { EditMesh, normalOf } from './editMesh';
import { type SphereRegion, insideRegion } from './region';
import { SurfaceIndex } from './surfaceIndex';

export interface RemeshParams {
  readonly targetEdge?: number;
  readonly minEdge?: number;
  readonly maxEdge?: number;
  readonly approxError?: number;
  readonly iterations: number;
  readonly featureAngleRad: number;
  readonly preserveBoundary: boolean;
  readonly project: boolean;
  readonly region?: SphereRegion;
}

interface EdgeStats {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p5: number;
  readonly p95: number;
}

export interface RemeshReport {
  readonly mode: 'isotropic' | 'adaptive';
  readonly iterations: number;
  readonly trianglesBefore: number;
  readonly trianglesAfter: number;
  readonly splits: number;
  readonly collapses: number;
  readonly flips: number;
  readonly edgeLength: EdgeStats;
  /** Fraction of edges inside [4/5, 4/3] of the local target. */
  readonly fractionInBand: number;
  readonly featureEdges: number;
}

const HIGH = 4 / 3;
const LOW = 4 / 5;
const KEY = 67_108_864;
const edgeKey = (a: number, b: number): number => (a < b ? a * KEY + b : b * KEY + a);
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 4 sqrt(3) area / sum of squared edges: 1 for an equilateral triangle, 0 for a sliver. */
function quality(a: Vec3, b: Vec3, c: Vec3): number {
  const sum =
    (a[0] - b[0]) ** 2 +
    (a[1] - b[1]) ** 2 +
    (a[2] - b[2]) ** 2 +
    (b[0] - c[0]) ** 2 +
    (b[1] - c[1]) ** 2 +
    (b[2] - c[2]) ** 2 +
    (c[0] - a[0]) ** 2 +
    (c[1] - a[1]) ** 2 +
    (c[2] - a[2]) ** 2;
  return sum > 0 ? (2 * Math.sqrt(3) * Math.hypot(...normalOf(a, b, c))) / sum : 0;
}

/** A replacement triangle is acceptable when it keeps the orientation and is not a sliver (or is no worse than what it replaces). */
const QUALITY_FLOOR = 0.15;
function acceptable(before: readonly [Vec3, Vec3, Vec3], after: readonly [Vec3, Vec3, Vec3]): boolean {
  if (dot(normalOf(...before), normalOf(...after)) <= 0) return false;
  const q = quality(...after);
  return q >= QUALITY_FLOOR || q >= quality(...before);
}

type Kind = 'free' | 'slide' | 'fixed';

/** Per-vertex target edge length of an adaptive remesh, from the input's curvature. */
function sizingField(reference: MeshData, params: RemeshParams): number[] {
  const { positions, indices } = reference;
  const count = positions.length / 3;
  const normals = new Array<number>(count * 3).fill(0);
  for (let f = 0; f + 2 < indices.length; f += 3) {
    const c = [indices[f] as number, indices[f + 1] as number, indices[f + 2] as number];
    const p = c.map((v) => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]] as number[]) as [number[], number[], number[]];
    const n = normalOf(p[0] as unknown as Vec3, p[1] as unknown as Vec3, p[2] as unknown as Vec3);
    for (const v of c) for (let a = 0; a < 3; a++) normals[v * 3 + a] = (normals[v * 3 + a] as number) + (n[a] as number);
  }
  const unit = (v: number): Vec3 => {
    const l = Math.hypot(normals[v * 3] as number, normals[v * 3 + 1] as number, normals[v * 3 + 2] as number) || 1;
    return [(normals[v * 3] as number) / l, (normals[v * 3 + 1] as number) / l, (normals[v * 3 + 2] as number) / l];
  };
  const kappa = new Array<number>(count).fill(0);
  for (let f = 0; f + 2 < indices.length; f += 3) {
    for (let k = 0; k < 3; k++) {
      const [a, b] = [indices[f + k] as number, indices[f + ((k + 1) % 3)] as number];
      const length = Math.hypot(
        (positions[a * 3] as number) - (positions[b * 3] as number),
        (positions[a * 3 + 1] as number) - (positions[b * 3 + 1] as number),
        (positions[a * 3 + 2] as number) - (positions[b * 3 + 2] as number),
      );
      if (length === 0) continue;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b)))));
      kappa[a] = Math.max(kappa[a] as number, angle / length);
      kappa[b] = Math.max(kappa[b] as number, angle / length);
    }
  }
  const [lo, hi, eps] = [params.minEdge as number, params.maxEdge as number, params.approxError as number];
  return kappa.map((k) => {
    if (k <= 1e-12) return hi;
    const square = (6 * eps) / k - 3 * eps * eps;
    return Math.min(hi, Math.max(lo, square > 0 ? Math.sqrt(square) : lo));
  });
}

class Remesher {
  readonly mesh: EditMesh;
  readonly feature = new Set<number>();
  splits = 0;
  collapses = 0;
  flips = 0;
  private readonly reference: SurfaceIndex;
  private readonly referenceMesh: MeshData;
  private readonly sizes: number[] | null;

  constructor(
    input: MeshData,
    private readonly params: RemeshParams,
  ) {
    this.mesh = new EditMesh(input.positions, input.indices);
    this.referenceMesh = input;
    this.reference = new SurfaceIndex(input.positions, input.indices);
    this.sizes = params.targetEdge === undefined ? sizingField(input, params) : null;
    const cosFeature = Math.cos(params.featureAngleRad);
    for (let a = 0; a < this.mesh.vertexTotal; a++)
      for (const b of this.mesh.ring(a)) {
        if (b < a) continue;
        const shared = this.mesh.facesOnEdge(a, b);
        if (shared.length !== 2) continue;
        const [n1, n2] = [this.mesh.faceNormal(shared[0] as number), this.mesh.faceNormal(shared[1] as number)];
        const l = Math.hypot(...n1) * Math.hypot(...n2);
        if (l > 0 && dot(n1, n2) / l < cosFeature) this.feature.add(edgeKey(a, b));
      }
  }

  /** Target edge length at point `p`. */
  size(p: Vec3): number {
    if (this.sizes === null) return this.params.targetEdge as number;
    const hit = this.reference.closest(p);
    if (hit.face < 0) return this.params.maxEdge as number;
    const [u, v, w] = this.reference.barycentric(hit.face, hit.point);
    const f = hit.face * 3;
    const s = (k: number): number => this.sizes?.[this.referenceMesh.indices[f + k] as number] as number;
    return u * s(0) + v * s(1) + w * s(2);
  }

  private edgeTarget(a: number, b: number): number {
    const [pa, pb] = [this.mesh.p(a), this.mesh.p(b)];
    return this.size([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]);
  }

  private movable(v: number): boolean {
    return insideRegion(this.params.region, this.mesh.p(v));
  }

  private constrainedEdges(v: number): number {
    let count = 0;
    for (const w of this.mesh.ring(v)) {
      if (this.feature.has(edgeKey(v, w))) count++;
      else if (!this.params.preserveBoundary && this.mesh.isBoundaryEdge(v, w)) count++;
    }
    return count;
  }

  kind(v: number): Kind {
    if (!this.movable(v)) return 'fixed';
    if (this.params.preserveBoundary && this.mesh.isBoundaryVertex(v)) return 'fixed';
    const degree = this.constrainedEdges(v);
    if (degree === 0) return 'free';
    if (degree !== 2) return 'fixed';
    // A line that turns sharply here is a corner: it stays where it is.
    const [a, b] = this.lineNeighbours(v);
    if (a === undefined || b === undefined) return 'fixed';
    const [p, pa, pb] = [this.mesh.p(v), this.mesh.p(a), this.mesh.p(b)];
    const u: Vec3 = [pa[0] - p[0], pa[1] - p[1], pa[2] - p[2]];
    const w: Vec3 = [pb[0] - p[0], pb[1] - p[1], pb[2] - p[2]];
    const cosine = dot(u, w) / (Math.hypot(...u) * Math.hypot(...w) || 1);
    return Math.PI - Math.acos(Math.max(-1, Math.min(1, cosine))) > this.params.featureAngleRad ? 'fixed' : 'slide';
  }

  /** The two vertices a constrained line leaves through. */
  private lineNeighbours(v: number): number[] {
    return this.mesh
      .ring(v)
      .filter((w) => this.isConstrainedEdge(v, w) && (this.feature.has(edgeKey(v, w)) || !this.params.preserveBoundary));
  }

  private isConstrainedEdge(a: number, b: number): boolean {
    return this.feature.has(edgeKey(a, b)) || this.mesh.isBoundaryEdge(a, b);
  }

  allEdges(): Array<[number, number]> {
    const edges: Array<[number, number]> = [];
    for (let a = 0; a < this.mesh.vertexTotal; a++) {
      if (this.mesh.vAlive[a] !== true) continue;
      for (const b of this.mesh.ring(a)) if (a < b) edges.push([a, b]);
    }
    return edges;
  }

  splitLong(): number {
    let count = 0;
    for (const [a, b] of this.allEdges()) {
      if (this.mesh.facesOnEdge(a, b).length === 0) continue;
      if (!this.movable(a) || !this.movable(b)) continue;
      const length = dist(this.mesh.p(a), this.mesh.p(b));
      if (length <= HIGH * this.edgeTarget(a, b)) continue;
      const wasFeature = this.feature.has(edgeKey(a, b));
      const [pa, pb] = [this.mesh.p(a), this.mesh.p(b)];
      let at: Vec3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
      if (this.params.project && !wasFeature && !this.mesh.isBoundaryEdge(a, b)) at = this.reference.closest(at).point;
      const crowded = this.mesh.facesOnEdge(a, b).some((f) => dist(this.mesh.p(this.mesh.opposite(f, a, b)), at) < 0.1 * length);
      if (crowded) {
        if (this.flipIfValid(a, b)) {
          this.flips++;
          continue;
        }
        at = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
        if (this.mesh.facesOnEdge(a, b).some((f) => dist(this.mesh.p(this.mesh.opposite(f, a, b)), at) < 1e-3 * length)) continue;
      }
      const m = this.mesh.split(a, b, at);
      if (wasFeature) {
        this.feature.delete(edgeKey(a, b));
        this.feature.add(edgeKey(a, m));
        this.feature.add(edgeKey(m, b));
      }
      count++;
    }
    this.splits += count;
    return count;
  }

  private canCollapse(r: number, k: number, at: Vec3): boolean {
    const mesh = this.mesh;
    const shared = mesh.facesOnEdge(r, k);
    if (shared.length < 1 || shared.length > 2) return false;
    const [ringR, ringK] = [mesh.ring(r), mesh.ring(k)];
    const common = ringR.filter((w) => ringK.includes(w));
    const apexes = shared.map((f) => mesh.opposite(f, r, k)).sort((x, y) => x - y);
    if (common.length !== apexes.length || common.some((w, i) => w !== apexes[i])) return false;
    if (!mesh.isBoundaryEdge(r, k) && mesh.isBoundaryVertex(r) && mesh.isBoundaryVertex(k)) return false;
    if (shared.length === 2 && new Set([...ringR, ...ringK]).size - 2 <= 3) return false;
    for (const w of ringR) if (w !== k && dist(at, mesh.p(w)) > HIGH * this.edgeTarget(w, k)) return false;
    for (const owner of [r, k]) {
      for (const f of mesh.vFaces[owner] as Set<number>) {
        if (shared.includes(f)) continue;
        const [x, y, z] = mesh.corners(f);
        const pos = (c: number): Vec3 => (c === r || c === k ? at : mesh.p(c));
        if (!acceptable([mesh.p(x), mesh.p(y), mesh.p(z)], [pos(x), pos(y), pos(z)])) return false;
      }
    }
    return true;
  }

  collapseShort(): number {
    let count = 0;
    for (const [a, b] of this.allEdges()) {
      const mesh = this.mesh;
      if (mesh.vAlive[a] !== true || mesh.vAlive[b] !== true || mesh.facesOnEdge(a, b).length === 0) continue;
      if (dist(mesh.p(a), mesh.p(b)) >= LOW * this.edgeTarget(a, b)) continue;
      const constrained = this.isConstrainedEdge(a, b);
      for (const [r, k] of [
        [b, a],
        [a, b],
      ] as const) {
        const kr = this.kind(r);
        const kk = this.kind(k);
        if (kr === 'fixed') continue;
        if (kr === 'slide' && !(constrained && kk !== 'free')) continue;
        if (kr === 'free' && constrained) continue;
        const at: Vec3 =
          kr === 'free' && kk === 'free'
            ? [(mesh.p(r)[0] + mesh.p(k)[0]) / 2, (mesh.p(r)[1] + mesh.p(k)[1]) / 2, (mesh.p(r)[2] + mesh.p(k)[2]) / 2]
            : mesh.p(k);
        if (!this.canCollapse(r, k, at)) continue;
        for (const w of mesh.ring(r)) {
          if (!this.feature.delete(edgeKey(r, w))) continue;
          if (w !== k) this.feature.add(edgeKey(k, w));
        }
        mesh.setP(k, at);
        mesh.collapse(r, k);
        count++;
        break;
      }
    }
    this.collapses += count;
    return count;
  }

  /** Flip the interior non-feature edge a-b when the quad is convex enough that both new faces are acceptable. */
  private flipIfValid(a: number, b: number): boolean {
    const mesh = this.mesh;
    const shared = mesh.facesOnEdge(a, b);
    if (shared.length !== 2 || this.feature.has(edgeKey(a, b))) return false;
    const [c, d] = [mesh.opposite(shared[0] as number, a, b), mesh.opposite(shared[1] as number, a, b)];
    if (c === d || mesh.facesOnEdge(c, d).length > 0 || ![a, b, c, d].every((v) => this.movable(v))) return false;
    const [pa, pb, pc, pd] = [mesh.p(a), mesh.p(b), mesh.p(c), mesh.p(d)];
    const first = mesh.hasDirected(shared[0] as number, a, b);
    const oldFaces = shared.map((f) => mesh.corners(f).map((v) => mesh.p(v)) as [Vec3, Vec3, Vec3]);
    const reference = oldFaces[0] as [Vec3, Vec3, Vec3];
    const quad: Array<[Vec3, Vec3, Vec3]> = first
      ? [
          [pa, pd, pc],
          [pd, pb, pc],
        ]
      : [
          [pa, pc, pd],
          [pc, pb, pd],
        ];
    if (dist(pc, pd) > HIGH * this.edgeTarget(c, d) && dist(pc, pd) > dist(pa, pb)) return false;
    const floor = Math.min(QUALITY_FLOOR, ...oldFaces.map((o) => quality(...o)));
    if (!quad.every((t) => acceptable(reference, t) && quality(...t) >= floor)) return false;
    return mesh.flip(a, b);
  }

  flipEdges(): number {
    const mesh = this.mesh;
    let count = 0;
    const valence = (v: number): number => mesh.ring(v).length;
    const target = (v: number): number => (mesh.isBoundaryVertex(v) || this.constrainedEdges(v) > 0 ? 4 : 6);
    for (const [a, b] of this.allEdges()) {
      if (mesh.vAlive[a] !== true || mesh.vAlive[b] !== true) continue;
      const shared = mesh.facesOnEdge(a, b);
      if (shared.length !== 2) continue;
      const [c, d] = [mesh.opposite(shared[0] as number, a, b), mesh.opposite(shared[1] as number, a, b)];
      if (valence(a) <= 3 || valence(b) <= 3) continue;
      const deviation = (v: number, delta: number): number => (valence(v) + delta - target(v)) ** 2;
      const before = deviation(a, 0) + deviation(b, 0) + deviation(c, 0) + deviation(d, 0);
      const after = deviation(a, -1) + deviation(b, -1) + deviation(c, 1) + deviation(d, 1);
      if (after >= before) continue;
      if (this.flipIfValid(a, b)) count++;
    }
    this.flips += count;
    return count;
  }

  private vertexNormal(v: number): Vec3 {
    let n: Vec3 = [0, 0, 0];
    for (const f of this.mesh.vFaces[v] as Set<number>) {
      const fn = this.mesh.faceNormal(f);
      n = [n[0] + fn[0], n[1] + fn[1], n[2] + fn[2]];
    }
    const l = Math.hypot(...n) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  }

  relax(): void {
    const mesh = this.mesh;
    const moves = new Map<number, Vec3>();
    for (let v = 0; v < mesh.vertexTotal; v++) {
      if (mesh.vAlive[v] !== true) continue;
      const kind = this.kind(v);
      if (kind === 'fixed') continue;
      const p = mesh.p(v);
      if (kind === 'free') {
        let weight = 0;
        let q: Vec3 = [0, 0, 0];
        for (const f of mesh.vFaces[v] as Set<number>) {
          const [a, b, c] = mesh.corners(f).map((x) => mesh.p(x)) as [Vec3, Vec3, Vec3];
          const w = Math.hypot(...normalOf(a, b, c)) / 2;
          q = [q[0] + (w * (a[0] + b[0] + c[0])) / 3, q[1] + (w * (a[1] + b[1] + c[1])) / 3, q[2] + (w * (a[2] + b[2] + c[2])) / 3];
          weight += w;
        }
        if (weight <= 0) continue;
        const u: Vec3 = [q[0] / weight - p[0], q[1] / weight - p[1], q[2] / weight - p[2]];
        const n = this.vertexNormal(v);
        const along = dot(u, n);
        moves.set(v, [p[0] + 0.5 * (u[0] - along * n[0]), p[1] + 0.5 * (u[1] - along * n[1]), p[2] + 0.5 * (u[2] - along * n[2])]);
      } else {
        const line = this.lineNeighbours(v);
        if (line.length !== 2) continue;
        const [pa, pb] = [mesh.p(line[0] as number), mesh.p(line[1] as number)];
        moves.set(v, [
          p[0] + 0.5 * ((pa[0] + pb[0]) / 2 - p[0]),
          p[1] + 0.5 * ((pa[1] + pb[1]) / 2 - p[1]),
          p[2] + 0.5 * ((pa[2] + pb[2]) / 2 - p[2]),
        ]);
      }
    }
    for (const [v, at] of moves) {
      const kind = this.kind(v);
      const target = this.params.project && kind === 'free' ? this.reference.closest(at).point : at;
      // A move that flips a face is skipped.
      let ok = true;
      for (const f of mesh.vFaces[v] as Set<number>) {
        const [x, y, z] = mesh.corners(f);
        const pos = (c: number): Vec3 => (c === v ? target : mesh.p(c));
        if (!acceptable([mesh.p(x), mesh.p(y), mesh.p(z)], [pos(x), pos(y), pos(z)])) {
          ok = false;
          break;
        }
      }
      if (ok) mesh.setP(v, target);
    }
  }

  edgeStats(): { stats: EdgeStats; inBand: number } {
    const lengths: number[] = [];
    let inBand = 0;
    const edges = this.allEdges();
    for (const [a, b] of edges) {
      const l = dist(this.mesh.p(a), this.mesh.p(b));
      lengths.push(l);
      const target = this.edgeTarget(a, b);
      if (l >= LOW * target * 0.999 && l <= HIGH * target * 1.001) inBand++;
    }
    const sorted = [...lengths].sort((x, y) => x - y);
    const at = (q: number): number =>
      sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number);
    return {
      stats: {
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
        mean: sorted.length === 0 ? 0 : sorted.reduce((s, v) => s + v, 0) / sorted.length,
        p5: at(0.05),
        p95: at(0.95),
      },
      inBand: edges.length === 0 ? 1 : inBand / edges.length,
    };
  }
}

/** Remesh a manifold, consistently wound, welded mesh. Parameters are validated by the caller (target or min/max/error present). */
export function remeshMesh(input: MeshData, params: RemeshParams): { mesh: MeshData; report: RemeshReport } {
  const remesher = new Remesher(input, params);
  const trianglesBefore = remesher.mesh.liveFaces;
  for (let i = 0; i < params.iterations; i++) {
    remesher.splitLong();
    remesher.collapseShort();
    remesher.flipEdges();
    remesher.relax();
  }
  for (let pass = 0; pass < 12 && remesher.splitLong() > 0; pass++) remesher.flipEdges();
  const { stats, inBand } = remesher.edgeStats();
  return {
    mesh: remesher.mesh.toMeshData(),
    report: {
      mode: params.targetEdge === undefined ? 'adaptive' : 'isotropic',
      iterations: params.iterations,
      trianglesBefore,
      trianglesAfter: remesher.mesh.liveFaces,
      splits: remesher.splits,
      collapses: remesher.collapses,
      flips: remesher.flips,
      edgeLength: stats,
      fractionInBand: inBand,
      featureEdges: remesher.feature.size,
    },
  };
}
