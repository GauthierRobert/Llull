/** Meshes and the digest shared by the native-against-TypeScript suites (the icosphere of VC-MSH-07 / 08, planar and wavy grids, noise, a box). */

import { createHash } from 'node:crypto';
import type { MeshData } from '@core/model/types';

const PHI = (1 + Math.sqrt(5)) / 2;

export function icosphere(radius: number, level: number): MeshData {
  const base: Array<[number, number, number]> = [
    [-1, PHI, 0],
    [1, PHI, 0],
    [-1, -PHI, 0],
    [1, -PHI, 0],
    [0, -1, PHI],
    [0, 1, PHI],
    [0, -1, -PHI],
    [0, 1, -PHI],
    [PHI, 0, -1],
    [PHI, 0, 1],
    [-PHI, 0, -1],
    [-PHI, 0, 1],
  ];
  let faces: number[][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  const onSphere = (v: number[]): number[] => {
    const n = Math.hypot(v[0] as number, v[1] as number, v[2] as number);
    return v.map((x) => (x * radius) / n);
  };
  let positions: number[][] = base.map(onSphere);
  for (let l = 0; l < level; l++) {
    const cache = new Map<string, number>();
    const next = positions.slice();
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let m = cache.get(key);
      if (m === undefined) {
        const [pa, pb] = [positions[a] as number[], positions[b] as number[]];
        m = next.length;
        next.push(
          onSphere([
            ((pa[0] as number) + (pb[0] as number)) / 2,
            ((pa[1] as number) + (pb[1] as number)) / 2,
            ((pa[2] as number) + (pb[2] as number)) / 2,
          ]),
        );
        cache.set(key, m);
      }
      return m;
    };
    const refined: number[][] = [];
    for (const [a, b, c] of faces as Array<[number, number, number]>) {
      const [ab, bc, ca] = [mid(a, b), mid(b, c), mid(c, a)];
      refined.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    positions = next;
    faces = refined;
  }
  return { positions: positions.flat(), indices: faces.flat() };
}

export function grid(size: number, n: number, height: (x: number, y: number) => number): MeshData {
  const h = size / n;
  const positions: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push(i * h, j * h, height(i * h, j * h));
  const id = (i: number, j: number): number => j * (n + 1) + i;
  const indices: number[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) indices.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
  return { positions, indices };
}

export function noisy(mesh: MeshData, amplitude: number): MeshData {
  let state = 42;
  const random = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  return { positions: mesh.positions.map((v) => v + (random() * 2 - 1) * amplitude), indices: mesh.indices };
}

export const hashOf = (mesh: MeshData): string =>
  createHash('sha256')
    .update(Buffer.from(Float64Array.from(mesh.positions).buffer))
    .update(Buffer.from(Uint32Array.from(mesh.indices).buffer))
    .digest('hex');

/** A box with every face split once: sharp feature edges, flat faces, planar neighbours. */
export function box(size: number, n: number): MeshData {
  const faces = [grid(size, n, () => 0)];
  const positions: number[] = [];
  const indices: number[] = [];
  const place = (mesh: MeshData, map: (x: number, y: number) => [number, number, number], flip: boolean): void => {
    const offset = positions.length / 3;
    for (let i = 0; i < mesh.positions.length; i += 3) positions.push(...map(mesh.positions[i] as number, mesh.positions[i + 1] as number));
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t] as number, mesh.indices[t + 1] as number, mesh.indices[t + 2] as number];
      indices.push(...(flip ? [a, c, b] : [a, b, c]).map((v) => v + offset));
    }
  };
  const [face] = faces as [MeshData];
  place(face, (x, y) => [x, y, 0], true);
  place(face, (x, y) => [x, y, size], false);
  place(face, (x, y) => [x, 0, y], false);
  place(face, (x, y) => [x, size, y], true);
  place(face, (x, y) => [0, x, y], true);
  place(face, (x, y) => [size, x, y], false);
  const welded = new Map<string, number>();
  const remap = new Array<number>(positions.length / 3);
  const unique: number[] = [];
  for (let v = 0; v < positions.length; v += 3) {
    const key = positions.slice(v, v + 3).join(',');
    let id = welded.get(key);
    if (id === undefined) {
      id = unique.length / 3;
      welded.set(key, id);
      unique.push(...positions.slice(v, v + 3));
    }
    remap[v / 3] = id;
  }
  return { positions: unique, indices: indices.map((v) => remap[v] as number) };
}

/**
 * `mesh` with `count` holes: the faces around evenly spaced vertices are removed (6 triangles for a vertex of valence 6), skipping vertices whose
 * neighbourhood touches an earlier hole, so every hole is its own boundary loop. Faces keep their order.
 */
export function withHoles(mesh: MeshData, count: number): MeshData {
  const vertices = mesh.positions.length / 3;
  const faceCount = mesh.indices.length / 3;
  const around: number[][] = Array.from({ length: vertices }, () => []);
  for (let f = 0; f < faceCount; f++) for (let k = 0; k < 3; k++) (around[mesh.indices[f * 3 + k] as number] as number[]).push(f);
  const removed = new Set<number>();
  const taken = new Set<number>();
  let holes = 0;
  const stride = Math.max(1, Math.floor(vertices / count));
  for (let v = Math.floor(stride / 2); v < vertices && holes < count; v += stride) {
    const faces = around[v] as number[];
    const ring = faces.flatMap((f) => [0, 1, 2].map((k) => mesh.indices[f * 3 + k] as number));
    if (ring.some((w) => taken.has(w))) continue;
    for (const f of faces) removed.add(f);
    for (const w of ring) taken.add(w);
    holes++;
  }
  const indices: number[] = [];
  for (let f = 0; f < faceCount; f++) if (!removed.has(f)) indices.push(...mesh.indices.slice(f * 3, f * 3 + 3));
  return { positions: mesh.positions, indices };
}
