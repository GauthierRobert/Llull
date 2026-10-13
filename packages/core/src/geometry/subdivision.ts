/**
 * Catmull-Clark subdivision of a closed polygon cage with sharp creases (DeRose et al. rules for infinitely sharp edges): crease edge
 * points are midpoints, a vertex on two creases follows the crease curve, a vertex on three or more stays a corner. Every level turns each
 * n-gon into n quads, so a level-L surface has (sum of face sides) × 4^(L-1) quads. Pure; shared by the viewport, export, measurement and
 * both kernels.
 */

import type { SubdivisionEntity, Vec3 } from '../model/types';
import { add3, centroid3, scale3 } from '../lib/vec3';
import type { Triangle } from './triangles';

/** Deepest refinement accepted (each level multiplies the face count by 4). */
export const MAX_SUBDIVISION_LEVELS = 4;

/** A polygon cage: vertices, counter-clockwise (outside view) faces, sharp edges. */
export interface Cage {
  readonly vertices: ReadonlyArray<Vec3>;
  readonly faces: ReadonlyArray<ReadonlyArray<number>>;
  readonly creases: ReadonlyArray<readonly [number, number]>;
}

/** Order-independent key of the edge a–b. */
export const edgeKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * First vertex whose faces do not form one fan (closed manifold assumed edge-wise): walking from
 * any face around the vertex, across the edge entering it, must visit all of its faces.
 */
function pinchedVertex(faces: ReadonlyArray<ReadonlyArray<number>>, count: number): number | null {
  /** Face holding the directed edge a→b. */
  const faceOf = new Map<string, number>();
  const around = Array.from({ length: count }, (): number[] => []);
  faces.forEach((face, f) =>
    face.forEach((a, i) => {
      faceOf.set(`${a}>${face[(i + 1) % face.length]}`, f);
      around[a]?.push(f);
    }),
  );
  for (let v = 0; v < count; v++) {
    const start = around[v]?.[0];
    if (start === undefined) continue;
    let face = start;
    let visited = 0;
    do {
      const loop = faces[face] as ReadonlyArray<number>;
      const previous = loop[(loop.indexOf(v) - 1 + loop.length) % loop.length] as number;
      face = faceOf.get(`${v}>${previous}`) as number;
      visited++;
    } while (face !== start && visited <= (around[v] as number[]).length);
    if (visited !== (around[v] as number[]).length) return v;
  }
  return null;
}

/**
 * Why `cage` is not a closed, consistently wound 2-manifold (null when it is): every directed
 * edge must appear once and its reverse once, faces need 3+ distinct in-range vertices, and every
 * crease must be a cage edge.
 */
export function cageProblem(cage: Cage): string | null {
  const count = cage.vertices.length;
  if (count < 4) return `a closed cage needs at least 4 vertices (got ${count})`;
  if (cage.faces.length < 4) return `a closed cage needs at least 4 faces (got ${cage.faces.length})`;
  const directed = new Set<string>();
  for (const [f, face] of cage.faces.entries()) {
    if (face.length < 3) return `face ${f} has ${face.length} vertices (needs 3+)`;
    if (new Set(face).size !== face.length) return `face ${f} repeats a vertex`;
    for (const [i, a] of face.entries()) {
      if (!Number.isInteger(a) || a < 0 || a >= count) return `face ${f} references vertex ${a}, outside 0..${count - 1}`;
      const b = face[(i + 1) % face.length] as number;
      if (directed.has(`${a}>${b}`))
        return `edge ${a}-${b} is used twice in the same direction (faces must all wind counter-clockwise seen from outside)`;
      directed.add(`${a}>${b}`);
    }
  }
  for (const key of directed) {
    const [a, b] = key.split('>');
    if (!directed.has(`${b}>${a}`)) return `edge ${a}-${b} borders only one face; the cage must be closed`;
  }
  const used = new Set(cage.faces.flat());
  for (let v = 0; v < count; v++) if (!used.has(v)) return `vertex ${v} is not used by any face`;
  const pinched = pinchedVertex(cage.faces, count);
  if (pinched !== null) return `vertex ${pinched} joins separate fans of faces (a pinch); give each sheet its own vertex`;
  for (const [a, b] of cage.creases) {
    if (!directed.has(`${a}>${b}`)) return `crease ${a}-${b} is not an edge of the cage`;
  }
  return null;
}

interface EdgeInfo {
  readonly a: number;
  readonly b: number;
  readonly faces: number[];
  readonly sharp: boolean;
}

/** One Catmull-Clark step (cage assumed valid: see cageProblem). */
function subdivideOnce(cage: Cage): Cage {
  const { vertices, faces } = cage;
  const sharpKeys = new Set(cage.creases.map(([a, b]) => edgeKey(a, b)));
  const edges = new Map<string, EdgeInfo>();
  faces.forEach((face, f) =>
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length] as number;
      const key = edgeKey(a, b);
      const edge = edges.get(key) ?? { a, b, faces: [], sharp: sharpKeys.has(key) };
      edge.faces.push(f);
      edges.set(key, edge);
    }),
  );
  const facePoints = faces.map((face) => centroid3(face.map((v) => vertices[v] as Vec3)));
  const edgeList = [...edges.values()];
  const edgeIndex = new Map(edgeList.map((edge, i) => [edgeKey(edge.a, edge.b), i]));
  const edgePoints = edgeList.map((edge) => {
    const ends = [vertices[edge.a] as Vec3, vertices[edge.b] as Vec3];
    return edge.sharp ? centroid3(ends) : centroid3([...ends, ...edge.faces.map((f) => facePoints[f] as Vec3)]);
  });
  const incident = vertices.map((): EdgeInfo[] => []);
  const adjacentFaces = vertices.map((): number[] => []);
  for (const edge of edgeList) {
    incident[edge.a]?.push(edge);
    incident[edge.b]?.push(edge);
  }
  faces.forEach((face, f) => face.forEach((v) => adjacentFaces[v]?.push(f)));
  const vertexPoints = vertices.map((p, v): Vec3 => {
    const around = incident[v] as EdgeInfo[];
    const sharp = around.filter((edge) => edge.sharp);
    if (sharp.length > 2) return p;
    if (sharp.length === 2) {
      const [first, second] = sharp.map((edge) => vertices[edge.a === v ? edge.b : edge.a] as Vec3);
      return scale3(add3(add3(scale3(p, 6), first as Vec3), second as Vec3), 1 / 8);
    }
    const n = around.length;
    const q = centroid3((adjacentFaces[v] as number[]).map((f) => facePoints[f] as Vec3));
    const r = centroid3(around.map((edge) => centroid3([vertices[edge.a] as Vec3, vertices[edge.b] as Vec3])));
    return scale3(add3(add3(q, scale3(r, 2)), scale3(p, n - 3)), 1 / n);
  });
  const edgeBase = vertices.length;
  const faceBase = edgeBase + edgeList.length;
  const edgeVertex = (a: number, b: number): number => edgeBase + (edgeIndex.get(edgeKey(a, b)) as number);
  const quads = faces.flatMap((face, f) =>
    face.map((v, i) => [
      v,
      edgeVertex(v, face[(i + 1) % face.length] as number),
      faceBase + f,
      edgeVertex(face[(i - 1 + face.length) % face.length] as number, v),
    ]),
  );
  const creases = edgeList
    .filter((edge) => edge.sharp)
    .flatMap((edge): Array<[number, number]> => {
      const middle = edgeVertex(edge.a, edge.b);
      return [
        [edge.a, middle],
        [middle, edge.b],
      ];
    });
  return { vertices: [...vertexPoints, ...edgePoints, ...facePoints], faces: quads, creases };
}

/** The cage refined `levels` times. */
export function subdivide(cage: Cage, levels: number): Cage {
  let current = cage;
  for (let level = 0; level < levels; level++) current = subdivideOnce(current);
  return current;
}

/** Closed, outward-wound triangles of a subdivision solid; `origin` is added to every vertex. */
export function subdivisionTriangles(
  entity: Pick<SubdivisionEntity, 'vertices' | 'faces' | 'creases' | 'levels'>,
  origin: Vec3 = [0, 0, 0],
): Triangle[] {
  const surface = subdivide(entity, entity.levels);
  const at = (v: number): Vec3 => add3(surface.vertices[v] as Vec3, origin);
  return surface.faces.flatMap((face) => {
    const triangles: Triangle[] = [];
    for (let k = 1; k + 1 < face.length; k++) triangles.push([at(face[0] as number), at(face[k] as number), at(face[k + 1] as number)]);
    return triangles;
  });
}

/**
 * Cage of an axis-aligned box `size` centred on the origin, `segments` cage faces along each
 * axis (outward, counter-clockwise faces).
 */
export function boxCage(size: Vec3, segments: readonly [number, number, number]): Cage {
  const [nx, ny, nz] = segments;
  const index = new Map<string, number>();
  const vertices: Vec3[] = [];
  const vertexAt = (i: number, j: number, k: number): number => {
    const key = `${i},${j},${k}`;
    const existing = index.get(key);
    if (existing !== undefined) return existing;
    vertices.push([(i / nx - 0.5) * size[0], (j / ny - 0.5) * size[1], (k / nz - 0.5) * size[2]]);
    index.set(key, vertices.length - 1);
    return vertices.length - 1;
  };
  const faces: number[][] = [];
  /** One side of the box: `grid(u, v)` maps a side cell corner to i, j, k; `flip` reverses winding. */
  const side = (nu: number, nv: number, grid: (u: number, v: number) => [number, number, number], flip: boolean): void => {
    for (let u = 0; u < nu; u++) {
      for (let v = 0; v < nv; v++) {
        const quad = [vertexAt(...grid(u, v)), vertexAt(...grid(u + 1, v)), vertexAt(...grid(u + 1, v + 1)), vertexAt(...grid(u, v + 1))];
        faces.push(flip ? quad.reverse() : quad);
      }
    }
  };
  side(nx, ny, (u, v) => [u, v, nz], false);
  side(nx, ny, (u, v) => [u, v, 0], true);
  side(nx, nz, (u, v) => [u, 0, v], false);
  side(nx, nz, (u, v) => [u, ny, v], true);
  side(ny, nz, (u, v) => [nx, u, v], false);
  side(ny, nz, (u, v) => [0, u, v], true);
  return { vertices, faces, creases: [] };
}

/**
 * Cage of a `sides`-gon prism along Z centred on the origin (circumradius `radius`), `segments`
 * rings of side faces, one n-gon per end cap.
 */
export function cylinderCage(radius: number, height: number, sides: number, segments: number): Cage {
  const vertices: Vec3[] = [];
  for (let k = 0; k <= segments; k++) {
    for (let i = 0; i < sides; i++) {
      const angle = (2 * Math.PI * i) / sides;
      vertices.push([radius * Math.cos(angle), radius * Math.sin(angle), (k / segments - 0.5) * height]);
    }
  }
  const at = (k: number, i: number): number => k * sides + (i % sides);
  const faces: number[][] = [];
  for (let k = 0; k < segments; k++) {
    for (let i = 0; i < sides; i++) faces.push([at(k, i), at(k, i + 1), at(k + 1, i + 1), at(k + 1, i)]);
  }
  const ring = (k: number): number[] => Array.from({ length: sides }, (_, i) => at(k, i));
  faces.push(ring(segments), ring(0).reverse());
  return { vertices, faces, creases: [] };
}
