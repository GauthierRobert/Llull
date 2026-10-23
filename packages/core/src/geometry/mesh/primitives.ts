/** Generated meshes (07 MSH FR-MSH-27): the icosphere and the flat grid, in document units. */

import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';

const PHI = (1 + Math.sqrt(5)) / 2;

const ICOSAHEDRON: Vec3[] = [
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

const ICOSAHEDRON_FACES: Array<[number, number, number]> = [
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

const onSphere = (v: Vec3, radius: number): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [(v[0] * radius) / length, (v[1] * radius) / length, (v[2] * radius) / length];
};

/** Closed outward-wound icosphere: the icosahedron projected onto the sphere, then `level` midpoint subdivisions, each re-projected (20 x 4^level triangles). */
export function icosphereMesh(radius: number, level: number, center: Vec3): MeshData {
  let positions: Vec3[] = ICOSAHEDRON.map((v) => onSphere(v, radius));
  let faces = ICOSAHEDRON_FACES;
  for (let l = 0; l < level; l++) {
    const cache = new Map<string, number>();
    const next = positions.slice();
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let m = cache.get(key);
      if (m === undefined) {
        const pa = positions[a] as Vec3;
        const pb = positions[b] as Vec3;
        m = next.length;
        next.push(onSphere([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2], radius));
        cache.set(key, m);
      }
      return m;
    };
    const refined: Array<[number, number, number]> = [];
    for (const [a, b, c] of faces) {
      const [ab, bc, ca] = [mid(a, b), mid(b, c), mid(c, a)];
      refined.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    positions = next;
    faces = refined;
  }
  return { positions: positions.flatMap((p) => [p[0] + center[0], p[1] + center[1], p[2] + center[2]]), indices: faces.flat() };
}

/** Flat grid of `size` [x, y] centred on `center` in the plane z = center z, `cells` [nx, ny], two +Z-wound triangles per cell. */
export function gridMeshOf(size: readonly [number, number], cells: readonly [number, number], center: Vec3): MeshData {
  const [nx, ny] = cells;
  const positions: number[] = [];
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++)
      positions.push(center[0] - size[0] / 2 + (i * size[0]) / nx, center[1] - size[1] / 2 + (j * size[1]) / ny, center[2]);
  const id = (i: number, j: number): number => j * (nx + 1) + i;
  const indices: number[] = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) indices.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
  return { positions, indices };
}
