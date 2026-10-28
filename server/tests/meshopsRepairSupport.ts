/** Meshes for the native-against-TypeScript suites of `repair` and `fill_holes` (DES-7c step 7, slice 2): soups, flipped shells, cracks, holes of every size. */

import type { MeshData } from '@core/model/types';
import { grid, icosphere, noisy } from './meshopsNativeSupport';

/** A deterministic stream in [0, 1) (an LCG, like `noisy`). */
export function stream(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** The faces of `mesh` that `keep` accepts (by face number), vertices unchanged. */
export function keepFaces(mesh: MeshData, keep: (face: number) => boolean): MeshData {
  const indices: number[] = [];
  for (let f = 0; f < mesh.indices.length / 3; f++) if (keep(f)) indices.push(...mesh.indices.slice(f * 3, f * 3 + 3));
  return { positions: mesh.positions, indices };
}

/** A square grid of `n` x `n` cells with the cells `[i0, i1) x [j0, j1)` left out: one boundary loop of 2 * ((i1 - i0) + (j1 - j0)) edges inside the outer loop. */
export function gridWithHole(n: number, hole: [number, number, number, number], height: (x: number, y: number) => number): MeshData {
  const [i0, i1, j0, j1] = hole;
  return keepFaces(grid(10, n, height), (face) => {
    const cell = Math.floor(face / 2);
    const [i, j] = [cell % n, Math.floor(cell / n)];
    return !(i >= i0 && i < i1 && j >= j0 && j < j1);
  });
}

/** Every face with its own three vertices, each copy moved by up to `jitter` per coordinate; unreferenced vertices are appended. */
export function soupOf(mesh: MeshData, jitter: number, seed: number): MeshData {
  const random = stream(seed);
  const positions = mesh.indices.flatMap((v) => mesh.positions.slice(v * 3, v * 3 + 3).map((x) => x + (random() * 2 - 1) * jitter));
  return { positions: [...positions, 7, 7, 7], indices: mesh.indices.map((_, i) => i) };
}

/** `mesh` with the winding of the faces listed (by number) reversed. */
export function flipFaces(mesh: MeshData, faces: ReadonlySet<number>): MeshData {
  const indices = [...mesh.indices];
  for (const f of faces) [indices[f * 3 + 1], indices[f * 3 + 2]] = [indices[f * 3 + 2] as number, indices[f * 3 + 1] as number];
  return { positions: mesh.positions, indices };
}

/** `parts` side by side along x, `gap` apart (one shell each). */
export function sideBySide(parts: readonly MeshData[], gap: number): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  parts.forEach((part, k) => {
    const offset = positions.length / 3;
    part.positions.forEach((x, i) => positions.push(i % 3 === 0 ? x + gap * k : x));
    indices.push(...part.indices.map((v) => v + offset));
  });
  return { positions, indices };
}

/** A noisy sphere with its faces around evenly spaced vertices removed in groups of two neighbouring fans (holes of 8 to 10 edges). */
export function bigHoleSphere(level: number, seed: number): MeshData {
  const sphere = noisy(icosphere(10, level), 0.02);
  const random = stream(seed);
  const doomed = new Set<number>();
  const faces = sphere.indices.length / 3;
  for (let h = 0; h < 6; h++) {
    const start = Math.floor(random() * faces);
    for (let k = 0; k < 4; k++) doomed.add((start + k) % faces);
  }
  return keepFaces(sphere, (f) => !doomed.has(f));
}

/** Two square wavy patches side by side with a crack of width `crack` between them: the vertices along the crack exist twice, `crack` apart. */
export function crackedPlane(n: number, crack: number): MeshData {
  const patch = grid(5, n, (_x, y) => 0.3 * Math.cos(y));
  return sideBySide([patch, patch], 5 + crack);
}
