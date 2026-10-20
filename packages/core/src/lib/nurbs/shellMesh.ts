/**
 * Shell meshing for sewing sheets into a closed solid (02 SRF M5): every sheet gets the same boundary points along a shared edge (equal arc-length
 * samples, whatever the parametrisation of the sheet), joined to an interior grid by a zipper strip, so the sheets weld without cracks; then the
 * vertices are welded, free and non-manifold edges counted, the orientation made consistent and the enclosed volume measured.
 */

import type { Vec3 } from '../../model/vectors';
import { cross3, dot3, distance3 } from '../vec3';
import { arcLengthSamples } from './arcSample';
import { curveLength } from './curvature';
import { curveDomain, evaluateCurve } from './evaluate';
import { evaluateSurface, isoCurve, surfaceDomain } from './surface';
import type { NurbsSurfaceData } from './surfaceTypes';

export interface PartMesh {
  readonly vertices: Vec3[];
  readonly triangles: Array<[number, number, number]>;
}

export interface SewnShell {
  readonly positions: number[];
  readonly indices: number[];
  /** Edges used by exactly one triangle after welding (each as its two end points). */
  readonly freeEdges: Array<[Vec3, Vec3]>;
  /** Edges shared by three or more triangles (count, and the middle of the first few). */
  readonly nonManifoldEdges: number;
  readonly nonManifoldAt: Vec3[];
  /** Total enclosed volume of the closed components (each oriented outward); meaningful only when the shell is closed. */
  readonly volume: number;
  readonly weldedVertices: number;
  /** Closed components (shells) found; the volume adds them up, so a nested shell is not subtracted: callers refuse more than one. */
  readonly components: number;
}

type Side = 'v0' | 'u1' | 'v1' | 'u0';

interface RingPoint {
  readonly point: Vec3;
  /** Position along the perimeter of the parameter rectangle, counter-clockwise from the lower left corner: [0, 4). */
  readonly p: number;
}

/**
 * Boundary samples of one side in the direction of the ring around the sheet, each with its perimeter position; a collapsed side (a pole)
 * gives its corner point once (at the start of the side).
 */
function sideSamples(surface: NurbsSurfaceData, side: Side, spacing: number, eps: number): RingPoint[] {
  const [[uMin, uMax], [vMin, vMax]] = surfaceDomain(surface);
  const [uRange, vRange] = [uMax - uMin, vMax - vMin];
  const curve =
    side === 'v0'
      ? isoCurve(surface, 'v', vMin)
      : side === 'v1'
        ? isoCurve(surface, 'v', vMax)
        : side === 'u0'
          ? isoCurve(surface, 'u', uMin)
          : isoCurve(surface, 'u', uMax);
  const offset = { v0: 0, u1: 1, v1: 2, u0: 3 }[side];
  const length = curveLength(curve, ...curveDomain(curve));
  if (length <= eps) return [{ point: evaluateCurve(curve, curveDomain(curve)[0]), p: offset }];
  const { points, parameters } = arcLengthSamples(curve, Math.max(2, Math.min(400, Math.ceil(length / spacing - 1e-6))));
  const along = (t: number): number =>
    side === 'v0' ? (t - uMin) / uRange : side === 'u1' ? (t - vMin) / vRange : side === 'v1' ? (uMax - t) / uRange : (vMax - t) / vRange;
  const samples = points.map((point, k) => ({ point, p: offset + along(parameters[k] as number) }));
  // the equal arc-length division is symmetric, so the direction does not change the positions: only the ring order matters
  return side === 'v1' || side === 'u0' ? samples.reverse() : samples;
}

/** Triangles of one sheet: interior grid plus a zipper annulus to the boundary samples (`gridPoints` >= 5 lines per direction). */
export function sheetShellMesh(surface: NurbsSurfaceData, spacing: number, eps: number, gridPoints: number): PartMesh {
  const [[uMin, uMax], [vMin, vMax]] = surfaceDomain(surface);
  const lines = (min: number, max: number): number[] =>
    Array.from({ length: gridPoints }, (_, k) => min + ((max - min) * k) / (gridPoints - 1));
  const [us, vs] = [lines(uMin, uMax), lines(vMin, vMax)];
  const vertices: Vec3[] = [];
  const known = new Map<number, number>();
  const grid = (i: number, j: number): number => {
    const key = i * gridPoints + j;
    let found = known.get(key);
    if (found === undefined) {
      found = vertices.push(evaluateSurface(surface, us[i] as number, vs[j] as number)) - 1;
      known.set(key, found);
    }
    return found;
  };
  const triangles: Array<[number, number, number]> = [];
  const last = gridPoints - 2;
  for (let i = 1; i < last; i++)
    for (let j = 1; j < last; j++) {
      const [a, b, c, d] = [grid(i, j), grid(i, j + 1), grid(i + 1, j), grid(i + 1, j + 1)];
      triangles.push([a, c, b], [b, c, d]);
    }
  // the inner ring (grid lines 1 and last) with the perimeter position of each vertex
  const fraction = (k: number): number => k / (gridPoints - 1);
  const inner: Array<{ index: number; p: number }> = [];
  for (let i = 1; i <= last; i++) inner.push({ index: grid(i, 1), p: fraction(i) });
  for (let j = 2; j <= last; j++) inner.push({ index: grid(last, j), p: 1 + fraction(j) });
  for (let i = last - 1; i >= 1; i--) inner.push({ index: grid(i, last), p: 2 + 1 - fraction(i) });
  for (let j = last - 1; j >= 2; j--) inner.push({ index: grid(1, j), p: 3 + 1 - fraction(j) });
  const outer: Array<{ index: number; p: number }> = [];
  for (const side of ['v0', 'u1', 'v1', 'u0'] as const) {
    const samples = sideSamples(surface, side, spacing, eps);
    // a side shares its last point with the next side's first: only collapsed sides (one point) keep theirs
    for (const sample of samples.length === 1 ? samples : samples.slice(0, -1))
      outer.push({ index: vertices.push(sample.point) - 1, p: sample.p });
  }
  const [a, b] = [inner.length, outer.length];
  const wrapped = (list: ReadonlyArray<{ p: number }>, k: number): number =>
    (list[k % list.length] as { p: number }).p + (k >= list.length ? 4 : 0);
  let [i, j] = [0, 0];
  while (i < a || j < b) {
    const [here, there] = [(inner[i % a] as { index: number }).index, (outer[j % b] as { index: number }).index];
    const [nextInner, nextOuter] = [(inner[(i + 1) % a] as { index: number }).index, (outer[(j + 1) % b] as { index: number }).index];
    // merge by perimeter position: the strip advances along whichever ring has the nearer next vertex
    if (j >= b || (i < a && wrapped(inner, i + 1) <= wrapped(outer, j + 1))) {
      triangles.push([here, there, nextInner]);
      i++;
    } else {
      triangles.push([there, nextOuter, here]);
      j++;
    }
  }
  return { vertices, triangles };
}

/** Welds the parts' vertices within `tolerance`, classifies edges, orients each closed component outward and measures the enclosed volume. */
export function sewParts(parts: ReadonlyArray<PartMesh>, tolerance: number): SewnShell {
  const positions: Vec3[] = [];
  const cells = new Map<string, number[]>();
  const weld = (p: Vec3): number => {
    const [cx, cy, cz] = p.map((value) => Math.floor(value / tolerance)) as [number, number, number];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const candidate of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? [])
            if (distance3(positions[candidate] as Vec3, p) <= tolerance) return candidate;
    const id = positions.push(p) - 1;
    const key = `${cx},${cy},${cz}`;
    cells.set(key, [...(cells.get(key) ?? []), id]);
    return id;
  };
  const triangles: Array<[number, number, number]> = [];
  for (const part of parts) {
    const map = part.vertices.map(weld);
    for (const [a, b, c] of part.triangles) {
      const [x, y, z] = [map[a] as number, map[b] as number, map[c] as number];
      if (x !== y && y !== z && x !== z) triangles.push([x, y, z]);
    }
  }
  interface Use {
    readonly triangle: number;
    /** The triangle, as stored, runs this edge from the smaller to the larger vertex index. */
    readonly forward: boolean;
  }
  const edgeUses = new Map<string, Use[]>();
  const edgeKey = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);
  triangles.forEach((triangle, t) => {
    for (let k = 0; k < 3; k++) {
      const [a, b] = [triangle[k] as number, triangle[(k + 1) % 3] as number];
      const key = edgeKey(a, b);
      edgeUses.set(key, [...(edgeUses.get(key) ?? []), { triangle: t, forward: a < b }]);
    }
  });
  const freeEdges: Array<[Vec3, Vec3]> = [];
  let nonManifoldEdges = 0;
  const nonManifoldAt: Vec3[] = [];
  for (const [key, uses] of edgeUses) {
    if (uses.length === 1) {
      const [a, b] = key.split('-').map(Number) as [number, number];
      freeEdges.push([positions[a] as Vec3, positions[b] as Vec3]);
    } else if (uses.length > 2) {
      nonManifoldEdges++;
      const [a, b] = key.split('-').map(Number) as [number, number];
      if (nonManifoldAt.length < 4) nonManifoldAt.push(positions[a] as Vec3);
      void b;
    }
  }
  const flipped = new Array<boolean>(triangles.length).fill(false);
  let volume = 0;
  let components = 0;
  if (freeEdges.length === 0 && nonManifoldEdges === 0) {
    const component = new Array<number>(triangles.length).fill(-1);
    const volumes: number[] = [];
    for (let start = 0; start < triangles.length; start++) {
      if ((component[start] as number) >= 0) continue;
      component[start] = volumes.length;
      volumes.push(0);
      const queue = [start];
      while (queue.length > 0) {
        const current = queue.pop() as number;
        const triangle = triangles[current] as [number, number, number];
        for (let k = 0; k < 3; k++) {
          const [a, b] = [triangle[k] as number, triangle[(k + 1) % 3] as number];
          const other = (edgeUses.get(edgeKey(a, b)) as Use[]).find((use) => use.triangle !== current) as Use;
          if ((component[other.triangle] as number) >= 0) continue;
          // consistent neighbours run a shared edge in opposite directions: flip the neighbour when it runs the same way
          flipped[other.triangle] = (other.forward === a < b) !== flipped[current];
          component[other.triangle] = component[start] as number;
          queue.push(other.triangle);
        }
      }
    }
    // volume of each component with the decided flips; a negative one is inside out and is turned
    const signed = new Array<number>(volumes.length).fill(0);
    triangles.forEach(([a, b, c], t) => {
      const [p, q, r] = [positions[a] as Vec3, positions[b] as Vec3, positions[c] as Vec3];
      signed[component[t] as number] =
        (signed[component[t] as number] as number) + (flipped[t] === true ? -1 : 1) * (dot3(p, cross3(q, r)) / 6);
    });
    triangles.forEach((_, t) => {
      if ((signed[component[t] as number] as number) < 0) flipped[t] = !flipped[t];
    });
    volume = signed.reduce((sum, value) => sum + Math.abs(value), 0);
    components = signed.length;
  }
  const indices = triangles.flatMap(([a, b, c], t) => (flipped[t] === true ? [a, c, b] : [a, b, c]));
  return {
    positions: positions.flat(),
    indices,
    freeEdges,
    nonManifoldEdges,
    nonManifoldAt,
    volume,
    weldedVertices: positions.length,
    components,
  };
}
