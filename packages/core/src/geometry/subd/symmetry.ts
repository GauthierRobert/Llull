/**
 * Mirror symmetry of a cage through entity-local coordinate planes at the origin (04 DIR §5.5): vertex pairing within a tolerance, the
 * mirror group (2^k permutations for k planes), symmetric edits (a delta computed for the moved vertices is applied reflected to every
 * mirror image) and the deviation measure. Pure.
 */

import type { Vec3 } from '../../model/types';
import type { CageSymmetry } from '../../model/subdivisionCage';
import { distance3 } from '../../lib/vec3';

export type SymmetryAxis = 'x' | 'y' | 'z';
const AXIS: Record<SymmetryAxis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

/** `p` with its `axis` component replaced by `value`. */
function withAxis(p: Vec3, axis: SymmetryAxis, value: number): Vec3 {
  return axis === 'x' ? [value, p[1], p[2]] : axis === 'y' ? [p[0], value, p[2]] : [p[0], p[1], value];
}

/** `p` reflected through the plane normal to `axis` at the origin. */
export function mirrorPoint(p: Vec3, axis: SymmetryAxis): Vec3 {
  return withAxis(p, axis, -p[AXIS[axis]]);
}

/** `p` projected onto the plane normal to `axis` at the origin. */
export function projectToPlane(p: Vec3, axis: SymmetryAxis): Vec3 {
  return withAxis(p, axis, 0);
}

export interface Pairing {
  /** `partners[k][v]` = mirror of `v` through `planes[k]` (undefined entries are listed in `unpaired`). */
  readonly partners: number[][];
  readonly unpaired: Array<{ readonly plane: SymmetryAxis; readonly vertex: number; readonly distance: number }>;
}

/** Unpaired vertices whose nearest-image distance is reported exactly (the rest say Infinity: the search is local). */
const REPORTED_DISTANCES = 16;

/** Pairs every vertex with its nearest mirror image within `tolerance` (spatial hash with tolerance-sized cells); a vertex on a plane is its own partner. */
export function pairVertices(vertices: ReadonlyArray<Vec3>, planes: readonly SymmetryAxis[], tolerance: number): Pairing {
  const unpaired: Pairing['unpaired'] = [];
  const cell = Math.max(tolerance, 1e-12);
  const cellOf = (p: Vec3): [number, number, number] => [Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)];
  const grid = new Map<string, number[]>();
  vertices.forEach((p, w) => {
    const key = cellOf(p).join(',');
    grid.set(key, [...(grid.get(key) ?? []), w]);
  });
  const partners = planes.map((plane) => {
    const row = new Array<number>(vertices.length).fill(-1);
    vertices.forEach((p, v) => {
      const target = mirrorPoint(p, plane);
      const [i, j, k] = cellOf(target);
      let best = -1;
      let bestDistance = Infinity;
      for (let di = -1; di <= 1; di++)
        for (let dj = -1; dj <= 1; dj++)
          for (let dk = -1; dk <= 1; dk++)
            for (const w of grid.get(`${i + di},${j + dj},${k + dk}`) ?? []) {
              const d = distance3(vertices[w] as Vec3, target);
              if (d < bestDistance) [best, bestDistance] = [w, d];
            }
      if (bestDistance <= tolerance) row[v] = best;
      else {
        const exact = unpaired.length < REPORTED_DISTANCES ? Math.min(...vertices.map((q) => distance3(q, target))) : Infinity;
        unpaired.push({ plane, vertex: v, distance: exact });
      }
    });
    row.forEach((w, v) => {
      if (w >= 0 && row[w] !== v) {
        row[v] = -1;
        unpaired.push({ plane, vertex: v, distance: distance3(vertices[w] as Vec3, mirrorPoint(vertices[v] as Vec3, plane)) });
      }
    });
    return row;
  });
  return { partners, unpaired };
}

/** Faces whose mirror image (vertices mapped through `partner`) is not a face of the cage. */
function unmirroredFaces(faces: ReadonlyArray<ReadonlyArray<number>>, partner: readonly number[]): number[] {
  const keys = new Set(faces.map((face) => [...face].sort((a, b) => a - b).join(',')));
  return faces.flatMap((face, f) =>
    keys.has(
      face
        .map((v) => partner[v] as number)
        .sort((a, b) => a - b)
        .join(','),
    )
      ? []
      : [f],
  );
}

/** One element of the mirror group: `mask` bit k = reflected through `planes[k]`; `map[v]` = image of vertex v. */
export interface MirrorImage {
  readonly mask: number;
  readonly map: readonly number[];
}

/** All 2^k images of the cage under the symmetry group (identity first). */
export function mirrorGroup(symmetry: CageSymmetry): MirrorImage[] {
  const count = (symmetry.partners[0] as ReadonlyArray<number>).length;
  const group: MirrorImage[] = [];
  for (let mask = 0; mask < 1 << symmetry.planes.length; mask++) {
    const map = Array.from({ length: count }, (_, v) =>
      symmetry.partners.reduce((at, row, k) => (mask & (1 << k) ? (row[at] as number) : at), v),
    );
    group.push({ mask, map });
  }
  return group;
}

/** Negates the components of `d` along the axes of the planes set in `mask`. */
function reflectDelta(d: Vec3, mask: number, symmetry: CageSymmetry): Vec3 {
  return symmetry.planes.reduce<Vec3>((out, plane, k) => (mask & (1 << k) ? mirrorPoint(out, plane) : out), d);
}

/**
 * The symmetric version of an edit: `edited` is the unconstrained result, `weights[v]` how strongly the edit drives each vertex (0 = not at all).
 * Every mirror orbit follows its most strongly driven vertex (lowest index on a tie), reflected, and vertices on a plane are projected back onto it.
 */
export function symmetrize(
  original: ReadonlyArray<Vec3>,
  edited: ReadonlyArray<Vec3>,
  weights: readonly number[],
  symmetry: CageSymmetry,
): Vec3[] {
  const group = mirrorGroup(symmetry);
  const out = original.map((p, v): Vec3 => {
    let source = -1;
    let sourceMask = 0;
    for (const image of group) {
      const u = image.map[v] as number;
      const w = weights[u] as number;
      if (w > 0 && (source < 0 || w > (weights[source] as number) || (w === weights[source] && u < source)))
        [source, sourceMask] = [u, image.mask];
    }
    if (source < 0) return p;
    const delta = reflectDelta(
      [
        (edited[source] as Vec3)[0] - (original[source] as Vec3)[0],
        (edited[source] as Vec3)[1] - (original[source] as Vec3)[1],
        (edited[source] as Vec3)[2] - (original[source] as Vec3)[2],
      ],
      sourceMask,
      symmetry,
    );
    return [p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]];
  });
  symmetry.planes.forEach((plane, k) => {
    out.forEach((p, v) => {
      if (symmetry.partners[k]?.[v] === v) out[v] = projectToPlane(p, plane);
    });
  });
  return out;
}

/** Largest distance between a vertex and the mirror image of its partner over all planes (0 for a symmetric cage). */
export function symmetryDeviation(vertices: ReadonlyArray<Vec3>, symmetry: CageSymmetry): number {
  let worst = 0;
  symmetry.planes.forEach((plane, k) => {
    vertices.forEach((p, v) => {
      const w = (symmetry.partners[k] as ReadonlyArray<number>)[v] as number;
      worst = Math.max(worst, distance3(p, mirrorPoint(vertices[w] as Vec3, plane)));
    });
  });
  return worst;
}

/** Faces in the mirror closure of `faces` (a face and all its images that exist). */
export function closeFacesUnderSymmetry(
  faces: ReadonlyArray<ReadonlyArray<number>>,
  selected: readonly number[],
  symmetry: CageSymmetry,
): number[] {
  const group = mirrorGroup(symmetry);
  const byKey = new Map(faces.map((face, f) => [[...face].sort((a, b) => a - b).join(','), f]));
  const out = new Set<number>();
  for (const f of selected) {
    for (const image of group) {
      out.add(
        byKey.get(
          (faces[f] as ReadonlyArray<number>)
            .map((v) => image.map[v] as number)
            .sort((a, b) => a - b)
            .join(','),
        ) as number,
      );
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Vertices of the cage seeded by `selected` and their mirror images. */
export function closeVerticesUnderSymmetry(selected: readonly number[], symmetry: CageSymmetry): number[] {
  const group = mirrorGroup(symmetry);
  return [...new Set(selected.flatMap((v) => group.map((image) => image.map[v] as number)))].sort((a, b) => a - b);
}

export const symmetricTopologyProblem = (faces: ReadonlyArray<ReadonlyArray<number>>, symmetry: CageSymmetry): number[] =>
  symmetry.partners.flatMap((row) => unmirroredFaces(faces, row));
