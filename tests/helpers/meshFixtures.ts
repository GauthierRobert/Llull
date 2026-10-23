/** Mesh generators of the 07 MSH validation pack (TypeScript port of docs/design/07-mesh-modeling/validation/lib_mesh.mjs) and a document builder. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { triangulateCap } from '@core/geometry/mesh/capTriangulate';

export interface IndexedMesh {
  positions: number[];
  indices: number[];
}

type V = [number, number, number];

const PACK_DIR = join(import.meta.dirname, '..', '..', 'docs', 'design', '07-mesh-modeling', 'validation');

export const packJson = (file: string): unknown => JSON.parse(readFileSync(join(PACK_DIR, 'data', file), 'utf8')) as unknown;
export const packFile = (file: string): Buffer => readFileSync(join(PACK_DIR, 'data', file));

const PHI = (1 + Math.sqrt(5)) / 2;

const ICOSAHEDRON: V[] = [
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

const onSphere = (v: V, r: number): V => {
  const n = Math.hypot(...v);
  return [(v[0] * r) / n, (v[1] * r) / n, (v[2] * r) / n];
};

/** Raw icosahedron of edge 2 (circumradius sqrt(1 + phi^2)); `project` false keeps the straight-edged polyhedron. */
export function icosahedron(): IndexedMesh {
  return { positions: ICOSAHEDRON.flat(), indices: ICOSAHEDRON_FACES.flat() };
}

/** Icosphere of radius r: icosahedron projected, then `level` midpoint subdivisions each re-projected onto the sphere. */
export function icosphere(r: number, level: number, center: V = [0, 0, 0]): IndexedMesh {
  let positions: V[] = ICOSAHEDRON.map((v) => onSphere(v, r));
  let faces = ICOSAHEDRON_FACES;
  for (let l = 0; l < level; l++) {
    const cache = new Map<string, number>();
    const next = positions.slice();
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let m = cache.get(key);
      if (m === undefined) {
        const pa = positions[a] as V;
        const pb = positions[b] as V;
        m = next.length;
        next.push(onSphere([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2], r));
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

/** Torus about +Z (major R, minor r, nu around the axis, nv around the tube). */
export function torus(R: number, r: number, nu: number, nv: number): IndexedMesh {
  const positions: number[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const [u, v] = [(2 * Math.PI * i) / nu, (2 * Math.PI * j) / nv];
      positions.push((R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v));
    }
  }
  const id = (i: number, j: number): number => ((i + nu) % nu) * nv + ((j + nv) % nv);
  const indices: number[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) indices.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
  }
  return { positions, indices };
}

/** Axis-aligned box [min, max] as 12 outward triangles on 8 vertices. */
export function cuboid(min: V, max: V): IndexedMesh {
  const corner = (i: number): V => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const quads = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  return {
    positions: Array.from({ length: 8 }, (_, i) => corner(i)).flat(),
    indices: quads.flatMap(([a, b, c, d]) => [a as number, b as number, c as number, a as number, c as number, d as number]),
  };
}

/** Flat grid [0,size]^2 at z = 0, n cells per side, wound +Z. */
export function gridMesh(size: number, n: number): IndexedMesh {
  const h = size / n;
  const positions: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push(i * h, j * h, 0);
  const id = (i: number, j: number): number => j * (n + 1) + i;
  const indices: number[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) indices.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
  return { positions, indices };
}

/** `mesh` as a triangle soup (9 numbers per triangle). */
export function soup(mesh: IndexedMesh): number[] {
  return mesh.indices.flatMap((i) => [
    mesh.positions[i * 3] as number,
    mesh.positions[i * 3 + 1] as number,
    mesh.positions[i * 3 + 2] as number,
  ]);
}

/** A document (mm) with the given meshes added by `import_mesh`; returns the ids in order. */
export function docWithMeshes(...meshes: IndexedMesh[]): { doc: CadDocument; ids: string[] } {
  let doc = createEmptyDocument();
  const ids: string[] = [];
  for (const mesh of meshes) {
    const result = execute(doc, 'import_mesh', { bodies: [{ positions: soup(mesh) }] });
    doc = result.document;
    ids.push(result.affected[0] as string);
  }
  return { doc, ids };
}

export const relativeError = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);

/**
 * Plate [0, length] x [0, width] x [0, thickness] with a through hole of `radius` at its centre, the hole wall a `segments`-gon with its vertices
 * on the circle (VC-MSH-23): 6 planes and 1 cylinder. Outward-wound, closed. The B-rep volume is length x width x thickness - pi r^2 thickness.
 */
export function plateWithHole(length = 40, width = 30, thickness = 5, radius = 5, segments = 64): IndexedMesh {
  const [cx, cy] = [length / 2, width / 2];
  const rim: Array<[number, number]> = Array.from({ length: segments }, (_, k) => [
    cx + radius * Math.cos((2 * Math.PI * k) / segments),
    cy + radius * Math.sin((2 * Math.PI * k) / segments),
  ]);
  const corners: Array<[number, number]> = [
    [0, 0],
    [length, 0],
    [length, width],
    [0, width],
  ];
  const cap = triangulateCap(corners, [rim]);
  const flat = [...corners, ...rim];
  const positions: number[] = [];
  for (const z of [0, thickness]) for (const [x, y] of flat) positions.push(x, y, z);
  const n = flat.length;
  const indices: number[] = [];
  for (const [a, b, c] of cap.triangles) {
    indices.push(n + a, n + b, n + c); // top, +Z
    indices.push(a, c, b); // bottom, -Z
  }
  const sides: Array<[number, number]> = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
  ];
  for (const [a, b] of sides) indices.push(a, b, n + b, a, n + b, n + a); // outward side quad
  for (let k = 0; k < segments; k++) {
    const [a, b] = [4 + k, 4 + ((k + 1) % segments)];
    indices.push(n + a, n + b, a, n + b, b, a); // hole wall, normal toward the axis
  }
  return { positions, indices };
}
