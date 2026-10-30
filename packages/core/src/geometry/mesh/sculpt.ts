/** Sculpt brushes (07 MSH FR-MSH-18, TECHNICAL_SPEC 5.7): deterministic stamps on an indexed triangle mesh, optionally mirrored. */

import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { EditMesh } from './editMesh';
import { insideRegion, type SphereRegion } from './region';
import { SurfaceIndex } from './surfaceIndex';
import { taubinMu } from './smooth';

export const SCULPT_BRUSHES = ['draw', 'inflate', 'grab', 'smooth', 'flatten', 'pinch', 'crease', 'layer'] as const;
type SculptBrush = (typeof SCULPT_BRUSHES)[number];
type SculptFalloff = 'constant' | 'linear' | 'smooth' | 'sphere';
type SculptPlane = 'yz' | 'xz' | 'xy';

export interface SculptParams {
  readonly brush: SculptBrush;
  readonly stamps: ReadonlyArray<Vec3>;
  readonly radius: number;
  readonly strength: number;
  readonly falloff: SculptFalloff;
  /** 'normal' per-vertex normals, 'area_normal' the area-weighted normal of the brush, or a fixed vector (the displacement of `grab`). */
  readonly direction: 'normal' | 'area_normal' | Vec3;
  readonly symmetry?: SculptPlane;
  readonly taubin: boolean;
  /** `layer`: largest height of the layer (document units). */
  readonly maxHeight?: number;
  /** Split edges longer than this inside the brush before stamping. */
  readonly refineEdge?: number;
  readonly mask?: SphereRegion;
  /** `flatten`: a point of the target plane; default the area-weighted centroid of the brush region at the start of each stamp. */
  readonly planePoint?: Vec3;
  /** Triangles the refined working mesh may reach (default SCULPT_MAX_TRIANGLES); the command never sets it, tests do. */
  readonly maxTriangles?: number;
}

/** Most triangles the mesh may have while `refineEdge` splits it: past it the refinement stops and the sculpt is refused (a tiny edge would fill the memory). */
export const SCULPT_MAX_TRIANGLES = 4_000_000;

/** `tooLarge`: the live triangles of the refined mesh when it passed the limit. */
export interface SculptTooLarge {
  readonly tooLarge: number;
}

export interface SculptResult {
  readonly mesh: MeshData;
  /** Index of the first stamp farther than `radius` from the surface, or null. */
  readonly offSurface: number | null;
  readonly movedVertices: number;
  readonly maxDisplacement: number;
  readonly displacedVolume: number | null;
  readonly volumeBasis: 'closed-volume-difference' | 'height-field-sum';
  readonly symmetryError: number | null;
  readonly refinedEdges: number;
  readonly stampsApplied: number;
}

const falloffOf = (kind: SculptFalloff, t: number): number => {
  if (t >= 1) return 0;
  switch (kind) {
    case 'constant':
      return 1;
    case 'linear':
      return 1 - t;
    case 'smooth':
      return (1 - t * t) * (1 - t * t);
    case 'sphere':
      return Math.sqrt(1 - t * t);
  }
};

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length > 0 ? [a[0] / length, a[1] / length, a[2] / length] : [0, 0, 0];
};
const AXIS: Record<SculptPlane, number> = { yz: 0, xz: 1, xy: 2 };

function mirror(v: Vec3, plane: SculptPlane): Vec3 {
  const axis = AXIS[plane];
  return [axis === 0 ? -v[0] : v[0], axis === 1 ? -v[1] : v[1], axis === 2 ? -v[2] : v[2]];
}

interface Topology {
  readonly neighbours: number[][];
  readonly vertexFaces: number[][];
}

function topologyOf(vertexCount: number, indices: ReadonlyArray<number>): Topology {
  const neighbours: Array<Set<number>> = Array.from({ length: vertexCount }, () => new Set<number>());
  const vertexFaces: number[][] = Array.from({ length: vertexCount }, () => []);
  for (let f = 0; f < indices.length / 3; f++) {
    const c = [indices[f * 3] as number, indices[f * 3 + 1] as number, indices[f * 3 + 2] as number];
    for (let k = 0; k < 3; k++) {
      (vertexFaces[c[k] as number] as number[]).push(f);
      (neighbours[c[k] as number] as Set<number>).add(c[(k + 1) % 3] as number);
      (neighbours[c[k] as number] as Set<number>).add(c[(k + 2) % 3] as number);
    }
  }
  return { neighbours: neighbours.map((set) => [...set].sort((a, b) => a - b)), vertexFaces };
}

class Sculptor {
  readonly position: Vec3[];
  private readonly topology: Topology;

  constructor(
    positions: ReadonlyArray<number>,
    private readonly indices: ReadonlyArray<number>,
    private readonly params: SculptParams,
  ) {
    this.position = Array.from(
      { length: positions.length / 3 },
      (_, i): Vec3 => [positions[i * 3] as number, positions[i * 3 + 1] as number, positions[i * 3 + 2] as number],
    );
    this.topology = topologyOf(this.position.length, indices);
  }

  private corners(f: number): [Vec3, Vec3, Vec3] {
    return [
      this.position[this.indices[f * 3] as number] as Vec3,
      this.position[this.indices[f * 3 + 1] as number] as Vec3,
      this.position[this.indices[f * 3 + 2] as number] as Vec3,
    ];
  }

  /** Area-weighted (twice the area) normal of a face. */
  private faceVector(f: number): Vec3 {
    const [a, b, c] = this.corners(f);
    return cross(sub(b, a), sub(c, a));
  }

  vertexNormal(v: number): Vec3 {
    let sum: Vec3 = [0, 0, 0];
    for (const f of this.topology.vertexFaces[v] as number[]) {
      const n = this.faceVector(f);
      sum = [sum[0] + n[0], sum[1] + n[1], sum[2] + n[2]];
    }
    return unit(sum);
  }

  /** One stamp's displacement of every vertex in the brush, from the current positions. */
  displacements(centre: Vec3, hint: Vec3 | null, layerBase: ReadonlyArray<Vec3>): Map<number, Vec3> {
    const { brush, radius, strength, falloff, direction, taubin, maxHeight, mask, planePoint: givenPlane } = this.params;
    const inBrush = new Map<number, number>();
    for (let v = 0; v < this.position.length; v++) {
      const p = this.position[v] as Vec3;
      const t = Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]) / radius;
      const weight = falloffOf(falloff, t);
      if (t < 1 && insideRegion(mask, p)) inBrush.set(v, weight);
    }
    const faces = new Set<number>();
    for (const v of inBrush.keys()) for (const f of this.topology.vertexFaces[v] as number[]) faces.add(f);
    let areaNormal: Vec3 = [0, 0, 0];
    let planePoint: Vec3 = [0, 0, 0];
    let areaSum = 0;
    for (const f of [...faces].sort((a, b) => a - b)) {
      const n = this.faceVector(f);
      const area = Math.hypot(n[0], n[1], n[2]) / 2;
      const [a, b, c] = this.corners(f);
      areaNormal = [areaNormal[0] + n[0], areaNormal[1] + n[1], areaNormal[2] + n[2]];
      planePoint = [
        planePoint[0] + (area * (a[0] + b[0] + c[0])) / 3,
        planePoint[1] + (area * (a[1] + b[1] + c[1])) / 3,
        planePoint[2] + (area * (a[2] + b[2] + c[2])) / 3,
      ];
      areaSum += area;
    }
    const nBar = typeof direction === 'string' || hint === null ? unit(areaNormal) : unit(hint);
    const fixed = typeof direction === 'string' ? null : (hint ?? direction);
    if (areaSum > 0) planePoint = [planePoint[0] / areaSum, planePoint[1] / areaSum, planePoint[2] / areaSum];
    if (givenPlane !== undefined) planePoint = givenPlane;
    const out = new Map<number, Vec3>();
    for (const [v, f] of [...inBrush].sort((a, b) => a[0] - b[0])) {
      const x = this.position[v] as Vec3;
      const along = (n: Vec3, amount: number): Vec3 => [n[0] * amount, n[1] * amount, n[2] * amount];
      const normalAt = direction === 'normal' ? this.vertexNormal(v) : nBar;
      const toCentre = sub(centre, x);
      const tangential = (): Vec3 => {
        const k = dot(toCentre, nBar);
        return [toCentre[0] - nBar[0] * k, toCentre[1] - nBar[1] * k, toCentre[2] - nBar[2] * k];
      };
      switch (brush) {
        case 'draw':
          out.set(v, along(normalAt, strength * f));
          break;
        case 'inflate':
          out.set(v, along(this.vertexNormal(v), strength * f));
          break;
        case 'grab':
          out.set(v, along(fixed ?? [0, 0, 0], f));
          break;
        case 'smooth': {
          const step = (amount: number, base: Vec3): Vec3 => {
            const ring = this.topology.neighbours[v] as number[];
            if (ring.length === 0) return [0, 0, 0];
            let mean: Vec3 = [0, 0, 0];
            for (const n of ring) {
              const p = this.position[n] as Vec3;
              mean = [mean[0] + p[0], mean[1] + p[1], mean[2] + p[2]];
            }
            return along(sub([mean[0] / ring.length, mean[1] / ring.length, mean[2] / ring.length], base), amount);
          };
          const lambda = Math.min(1, strength * f);
          const first = step(lambda, x);
          if (taubin && lambda > 0) {
            const mu = taubinMu(lambda, 0.1);
            const moved: Vec3 = [x[0] + first[0], x[1] + first[1], x[2] + first[2]];
            const second = step(mu, moved);
            out.set(v, [first[0] + second[0], first[1] + second[1], first[2] + second[2]]);
          } else out.set(v, first);
          break;
        }
        case 'flatten':
          out.set(v, along(nBar, -strength * f * dot(sub(x, planePoint), nBar)));
          break;
        case 'pinch': {
          const t = tangential();
          out.set(v, along(t, strength * f));
          break;
        }
        case 'crease': {
          const t = tangential();
          const lift = along(nBar, -strength * f);
          out.set(v, [lift[0] + (t[0] * strength * f) / 2, lift[1] + (t[1] * strength * f) / 2, lift[2] + (t[2] * strength * f) / 2]);
          break;
        }
        case 'layer': {
          const height = Math.min(strength * f, maxHeight ?? Number.POSITIVE_INFINITY);
          const base = layerBase[v] as Vec3;
          const target: Vec3 = [base[0] + nBar[0] * height, base[1] + nBar[1] * height, base[2] + nBar[2] * height];
          // No accumulation: a vertex never goes below the height an earlier stamp of the stroke gave it.
          const already = dot(sub(x, base), nBar);
          out.set(v, height > already ? sub(target, x) : [0, 0, 0]);
          break;
        }
      }
    }
    return out;
  }
}

function closestOnSurface(index: SurfaceIndex, point: Vec3): { point: Vec3; distance: number } {
  const hit = index.closest(point);
  return { point: hit.point, distance: hit.distance };
}

/** Area-weighted displacement of an open height field along the before-normal of each face; the closed-mesh case uses the volume difference. */
function heightFieldVolume(before: MeshData, after: ReadonlyArray<Vec3>): number {
  let total = 0;
  for (let f = 0; f < before.indices.length / 3; f++) {
    const ids = [before.indices[f * 3] as number, before.indices[f * 3 + 1] as number, before.indices[f * 3 + 2] as number];
    const p = ids.map(
      (i): Vec3 => [before.positions[i * 3] as number, before.positions[i * 3 + 1] as number, before.positions[i * 3 + 2] as number],
    );
    const n = cross(sub(p[1] as Vec3, p[0] as Vec3), sub(p[2] as Vec3, p[0] as Vec3));
    const twiceArea = Math.hypot(n[0], n[1], n[2]);
    if (twiceArea === 0) continue;
    const nu = unit(n);
    let mean = 0;
    for (let k = 0; k < 3; k++) mean += dot(sub(after[ids[k] as number] as Vec3, p[k] as Vec3), nu) / 3;
    total += (twiceArea / 2) * mean;
  }
  return total;
}

function signedVolume(positions: ReadonlyArray<Vec3>, indices: ReadonlyArray<number>): number {
  let volume = 0;
  for (let f = 0; f < indices.length / 3; f++) {
    const a = positions[indices[f * 3] as number] as Vec3;
    const b = positions[indices[f * 3 + 1] as number] as Vec3;
    const c = positions[indices[f * 3 + 2] as number] as Vec3;
    volume += dot(a, cross(b, c)) / 6;
  }
  return volume;
}

function isClosed(indices: ReadonlyArray<number>): boolean {
  const count = new Map<string, number>();
  for (let f = 0; f < indices.length / 3; f++) {
    for (let k = 0; k < 3; k++) {
      const a = indices[f * 3 + k] as number;
      const b = indices[f * 3 + ((k + 1) % 3)] as number;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  return count.size > 0 && [...count.values()].every((n) => n === 2);
}

/** Largest distance between a vertex and its mirror partner (the vertex at the mirrored position, found on the input); null without a pair. */
function symmetryErrorOf(input: MeshData, positions: ReadonlyArray<Vec3>, plane: SculptPlane, tolerance: number): number | null {
  const cell = (p: Vec3): string => p.map((c) => Math.round(c / tolerance)).join(',');
  const buckets = new Map<string, number>();
  for (let v = 0; v < input.positions.length / 3; v++) {
    buckets.set(cell([input.positions[v * 3] as number, input.positions[v * 3 + 1] as number, input.positions[v * 3 + 2] as number]), v);
  }
  let worst: number | null = null;
  for (let v = 0; v < input.positions.length / 3; v++) {
    const original: Vec3 = [input.positions[v * 3] as number, input.positions[v * 3 + 1] as number, input.positions[v * 3 + 2] as number];
    const partner = buckets.get(cell(mirror(original, plane)));
    if (partner === undefined) continue;
    const a = positions[v] as Vec3;
    const b = mirror(positions[partner] as Vec3, plane);
    worst = Math.max(worst ?? 0, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  }
  return worst;
}

/**
 * The edges of one refinement pass as (low, high): an edge once per live face that runs it from the lower to the higher index, in face order; an edge no face runs
 * that way (a boundary edge traversed from the higher index) once, at its first face, so it is split too.
 */
function passEdges(edit: EditMesh): Array<[number, number]> {
  const pairs = (f: number): Array<[number, number]> => {
    const [a, b, c] = edit.corners(f);
    return [
      [a, b],
      [b, c],
      [c, a],
    ];
  };
  const total = edit.vertexTotal;
  const ascending = new Set<number>();
  for (let f = 0; f < edit.faces.length / 3; f++)
    if (edit.fAlive[f]) for (const [u, v] of pairs(f)) if (u < v) ascending.add(u * total + v);
  const edges: Array<[number, number]> = [];
  for (let f = 0; f < edit.faces.length / 3; f++) {
    if (!edit.fAlive[f]) continue;
    for (const [u, v] of pairs(f)) {
      if (u < v) edges.push([u, v]);
      else if (u > v && !ascending.has(v * total + u)) {
        ascending.add(v * total + u);
        edges.push([v, u]);
      }
    }
  }
  return edges;
}

function refine(mesh: MeshData, params: SculptParams, centres: ReadonlyArray<Vec3>): { mesh: MeshData; splits: number } | SculptTooLarge {
  const limit = params.refineEdge;
  if (limit === undefined) return { mesh, splits: 0 };
  const edit = new EditMesh(mesh.positions, mesh.indices);
  let splits = 0;
  for (let pass = 0; pass < 8; pass++) {
    let count = 0;
    const edges = passEdges(edit);
    for (const [u, v] of edges) {
      if (edit.liveFaces > (params.maxTriangles ?? SCULPT_MAX_TRIANGLES)) return { tooLarge: edit.liveFaces };
      if (edit.facesOnEdge(u, v).length === 0) continue;
      const [pu, pv] = [edit.p(u), edit.p(v)];
      const length = Math.hypot(pu[0] - pv[0], pu[1] - pv[1], pu[2] - pv[2]);
      if (length <= limit) continue;
      const mid: Vec3 = [(pu[0] + pv[0]) / 2, (pu[1] + pv[1]) / 2, (pu[2] + pv[2]) / 2];
      if (!centres.some((c) => Math.hypot(mid[0] - c[0], mid[1] - c[1], mid[2] - c[2]) < params.radius)) continue;
      edit.split(u, v, mid);
      count++;
    }
    splits += count;
    if (count === 0) break;
  }
  return { mesh: edit.toMeshData(), splits };
}

/** Apply every stamp in order; stamps farther than `radius` from the input surface are reported through `offSurface` (nothing is moved then). */
export function sculptMesh(input: MeshData, params: SculptParams): SculptResult | SculptTooLarge {
  const tolerance = 1e-9 * Math.max(1, params.radius);
  const surface = new SurfaceIndex(input.positions, input.indices);
  const projected: Vec3[] = [];
  for (const [i, stamp] of params.stamps.entries()) {
    const hit = closestOnSurface(surface, stamp);
    if (hit.distance > params.radius) return emptyResult(input, i);
    projected.push(hit.point);
  }
  const centres: Vec3[] = [...projected];
  if (params.symmetry !== undefined) for (const p of projected) centres.push(mirror(p, params.symmetry));
  const refined = refine(input, params, centres);
  if ('tooLarge' in refined) return refined;
  const sculptor = new Sculptor(refined.mesh.positions, refined.mesh.indices, params);
  const base: Vec3[] = sculptor.position.map((p): Vec3 => [p[0], p[1], p[2]]);
  const original = base.map((p): Vec3 => [p[0], p[1], p[2]]);
  let applied = 0;
  for (const centre of projected) {
    const direction = params.direction;
    const vector = typeof direction === 'string' ? null : direction;
    const fields = [sculptor.displacements(centre, vector, base)];
    const mirrored = params.symmetry === undefined ? null : mirror(centre, params.symmetry);
    const distinct = mirrored !== null && Math.hypot(mirrored[0] - centre[0], mirrored[1] - centre[1], mirrored[2] - centre[2]) > tolerance;
    if (mirrored !== null && distinct && params.symmetry !== undefined) {
      fields.push(sculptor.displacements(mirrored, vector === null ? null : mirror(vector, params.symmetry), base));
    }
    const total = new Map<number, Vec3>();
    for (const field of fields) {
      for (const [v, d] of field) {
        const previous = total.get(v);
        total.set(v, previous === undefined ? d : [previous[0] + d[0], previous[1] + d[1], previous[2] + d[2]]);
      }
    }
    for (const [v, d] of total) {
      const p = sculptor.position[v] as Vec3;
      sculptor.position[v] = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
    }
    applied += fields.length;
  }
  const finalPositions = sculptor.position;
  let moved = 0;
  let maxDisplacement = 0;
  for (let v = 0; v < finalPositions.length; v++) {
    const a = finalPositions[v] as Vec3;
    const b = original[v] as Vec3;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (d > 0) moved++;
    maxDisplacement = Math.max(maxDisplacement, d);
  }
  const closed = isClosed(refined.mesh.indices);
  const volume = closed
    ? signedVolume(finalPositions, refined.mesh.indices) - signedVolume(original, refined.mesh.indices)
    : heightFieldVolume(refined.mesh, finalPositions);
  return {
    mesh: { positions: finalPositions.flatMap((p) => [p[0], p[1], p[2]]), indices: [...refined.mesh.indices] },
    offSurface: null,
    movedVertices: moved,
    maxDisplacement,
    displacedVolume: volume,
    volumeBasis: closed ? 'closed-volume-difference' : 'height-field-sum',
    symmetryError: params.symmetry === undefined ? null : symmetryErrorOf(refined.mesh, finalPositions, params.symmetry, tolerance),
    refinedEdges: refined.splits,
    stampsApplied: applied,
  };
}

function emptyResult(input: MeshData, offSurface: number): SculptResult {
  return {
    mesh: input,
    offSurface,
    movedVertices: 0,
    maxDisplacement: 0,
    displacedVolume: null,
    volumeBasis: 'height-field-sum',
    symmetryError: null,
    refinedEdges: 0,
    stampsApplied: 0,
  };
}
