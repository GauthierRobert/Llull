/**
 * Mutable indexed triangle mesh with vertex -> faces adjacency, the working structure of decimation and remeshing. Faces keep their index
 * while alive; new faces are appended, so every traversal is deterministic. Local to one engine call: never stored in a document.
 */

import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';

export class EditMesh {
  readonly pos: number[];
  readonly vAlive: boolean[];
  readonly faces: number[];
  readonly fAlive: boolean[];
  readonly vFaces: Array<Set<number>>;
  liveFaces = 0;

  constructor(positions: ReadonlyArray<number>, triangles: ReadonlyArray<number>) {
    this.pos = [...positions];
    this.vAlive = Array.from({ length: positions.length / 3 }, () => true);
    this.faces = [...triangles];
    this.fAlive = Array.from({ length: triangles.length / 3 }, () => true);
    this.vFaces = Array.from({ length: positions.length / 3 }, () => new Set<number>());
    for (let f = 0; f < this.fAlive.length; f++) {
      for (let k = 0; k < 3; k++) this.vFaces[this.faces[f * 3 + k] as number]?.add(f);
    }
    this.liveFaces = this.fAlive.length;
  }

  get vertexTotal(): number {
    return this.vAlive.length;
  }

  p(v: number): Vec3 {
    return [this.pos[v * 3] as number, this.pos[v * 3 + 1] as number, this.pos[v * 3 + 2] as number];
  }

  setP(v: number, x: Vec3): void {
    this.pos[v * 3] = x[0];
    this.pos[v * 3 + 1] = x[1];
    this.pos[v * 3 + 2] = x[2];
  }

  corners(f: number): [number, number, number] {
    return [this.faces[f * 3] as number, this.faces[f * 3 + 1] as number, this.faces[f * 3 + 2] as number];
  }

  addVertex(x: Vec3): number {
    this.pos.push(x[0], x[1], x[2]);
    this.vAlive.push(true);
    this.vFaces.push(new Set<number>());
    return this.vAlive.length - 1;
  }

  addFace(a: number, b: number, c: number): number {
    const f = this.fAlive.length;
    this.faces.push(a, b, c);
    this.fAlive.push(true);
    this.vFaces[a]?.add(f);
    this.vFaces[b]?.add(f);
    this.vFaces[c]?.add(f);
    this.liveFaces++;
    return f;
  }

  removeFace(f: number): void {
    if (this.fAlive[f] !== true) return;
    this.fAlive[f] = false;
    for (const v of this.corners(f)) this.vFaces[v]?.delete(f);
    this.liveFaces--;
  }

  /** Rewrite the corners of face `f` (adjacency follows). */
  setFace(f: number, a: number, b: number, c: number): void {
    for (const v of this.corners(f)) this.vFaces[v]?.delete(f);
    this.faces[f * 3] = a;
    this.faces[f * 3 + 1] = b;
    this.faces[f * 3 + 2] = c;
    for (const v of [a, b, c]) this.vFaces[v]?.add(f);
  }

  removeVertex(v: number): void {
    this.vAlive[v] = false;
  }

  /** Neighbour vertices of `v`, ascending. */
  ring(v: number): number[] {
    const out = new Set<number>();
    for (const f of this.vFaces[v] ?? []) for (const w of this.corners(f)) if (w !== v) out.add(w);
    return [...out].sort((x, y) => x - y);
  }

  /** Faces using the edge a-b, ascending. */
  facesOnEdge(a: number, b: number): number[] {
    const out: number[] = [];
    for (const f of this.vFaces[a] ?? []) if (this.vFaces[b]?.has(f) === true) out.push(f);
    return out.sort((x, y) => x - y);
  }

  /** Third vertex of face `f` besides `a` and `b`. */
  opposite(f: number, a: number, b: number): number {
    const [x, y, z] = this.corners(f);
    return x !== a && x !== b ? x : y !== a && y !== b ? y : z;
  }

  isBoundaryEdge(a: number, b: number): boolean {
    return this.facesOnEdge(a, b).length === 1;
  }

  isBoundaryVertex(v: number): boolean {
    for (const w of this.ring(v)) if (this.isBoundaryEdge(v, w)) return true;
    return false;
  }

  /** True when face `f` runs a -> b (in that cyclic direction). */
  hasDirected(f: number, a: number, b: number): boolean {
    const [x, y, z] = this.corners(f);
    return (x === a && y === b) || (y === a && z === b) || (z === a && x === b);
  }

  faceNormal(f: number): Vec3 {
    const [a, b, c] = this.corners(f).map((v) => this.p(v)) as [Vec3, Vec3, Vec3];
    return normalOf(a, b, c);
  }

  /** Remove vertex `u`, merging it into `v`: faces holding both vanish, the others swap u for v. */
  collapse(u: number, v: number): void {
    for (const f of [...(this.vFaces[u] ?? [])]) {
      if (this.vFaces[v]?.has(f) === true) this.removeFace(f);
      else {
        const [a, b, c] = this.corners(f);
        this.setFace(f, a === u ? v : a, b === u ? v : b, c === u ? v : c);
      }
    }
    this.removeVertex(u);
  }

  /** Split the edge a-b at a new vertex placed at `at`; every face on the edge becomes two. Returns the new vertex. */
  split(a: number, b: number, at: Vec3): number {
    const m = this.addVertex(at);
    for (const f of this.facesOnEdge(a, b)) {
      const c = this.opposite(f, a, b);
      if (this.hasDirected(f, a, b)) {
        this.setFace(f, a, m, c);
        this.addFace(m, b, c);
      } else {
        this.setFace(f, b, m, c);
        this.addFace(m, a, c);
      }
    }
    return m;
  }

  /** Flip the interior edge a-b to the diagonal between the two opposite vertices; false when it is not an interior edge. */
  flip(a: number, b: number): boolean {
    const shared = this.facesOnEdge(a, b);
    if (shared.length !== 2) return false;
    const f1 = this.hasDirected(shared[0] as number, a, b) ? (shared[0] as number) : (shared[1] as number);
    const second = f1 === shared[0] ? (shared[1] as number) : (shared[0] as number);
    const c = this.opposite(f1, a, b);
    const d = this.opposite(second, a, b);
    this.setFace(f1, a, d, c);
    this.setFace(second, d, b, c);
    return true;
  }

  /** Compact, canonical output: faces in ascending index, vertices in first-use order. */
  toMeshData(): MeshData {
    const remap = new Int32Array(this.vAlive.length).fill(-1);
    const positions: number[] = [];
    const indices: number[] = [];
    for (let f = 0; f < this.fAlive.length; f++) {
      if (this.fAlive[f] !== true) continue;
      for (const v of this.corners(f)) {
        if ((remap[v] as number) < 0) {
          remap[v] = positions.length / 3;
          positions.push(this.pos[v * 3] as number, this.pos[v * 3 + 1] as number, this.pos[v * 3 + 2] as number);
        }
        indices.push(remap[v] as number);
      }
    }
    return { positions, indices };
  }
}

/** Unnormalised face normal (twice the area vector). */
export function normalOf(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const [ux, uy, uz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const [vx, vy, vz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}
